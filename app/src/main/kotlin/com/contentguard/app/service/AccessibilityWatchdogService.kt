package com.contentguard.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.database.ContentObserver
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import com.contentguard.app.R
import com.contentguard.app.util.DebugLogBuffer

/**
 * Answers a real gap in the cascade: ColorOS's "Hide apps" feature doesn't
 * just remove the launcher icon for a hidden app - confirmed via direct
 * testing that it also strips ContentGuardService out of
 * Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, silently turning off
 * every gate with no user-visible warning. MacroDroid was confirmed to
 * survive the exact same "Hide apps" action on the same device - it very
 * likely does so by watching for exactly this and writing itself back
 * into the enabled-services list, the same mechanism this service
 * implements. MacroDroid documents needing the identical permission below
 * for this kind of self-management, which is corroborating evidence this
 * approach is the right one, not just a guess.
 *
 * Requires WRITE_SECURE_SETTINGS, which - same as for MacroDroid, and same
 * as this project's own SETUP.md already documents doing manually via adb
 * for the *initial* enable - can only be granted via a one-time adb
 * command, never at runtime by the app itself:
 *   adb shell pm grant <applicationId> android.permission.WRITE_SECURE_SETTINGS
 * Without that grant, [checkAndRestore] fails closed (logs and does
 * nothing) rather than crashing.
 *
 * Deliberately unconditional: this restores ContentGuardService to the
 * enabled list whenever it's found missing, with no attempt to guess
 * whether a human deliberately disabled it first - same reasoning as the
 * password-gated Settings/Accessibility screens and the incognito-
 * detection gate elsewhere in this app, both of which exist specifically
 * so protection can't be casually switched off. The real "off switch" here
 * is stopping this service itself (e.g. `adb shell am stopservice` or
 * force-stopping the app), not toggling accessibility off in Settings.
 *
 * Runs as its own foreground service, deliberately separate from
 * ContentGuardService - it has to be, since the whole point is to recover
 * from ContentGuardService itself being torn down, so watchdog logic
 * living inside that same service would die at the exact moment it's
 * needed. A ContentObserver on ENABLED_ACCESSIBILITY_SERVICES reacts
 * immediately when the OS changes that list; [BootReceiver] starts this
 * service after every reboot as a second entry point, and
 * ContentGuardService.onServiceConnected() starts it defensively too, in
 * case the device never reboots after this feature is first shipped.
 *
 * Known limitation, not fixable from here: if ColorOS's hide-apps action
 * ever kills this service's own process outright (rather than just
 * deregistering the accessibility service while everything else keeps
 * running), this can't self-heal - there is no code that can run once its
 * own process is gone. Real-device testing (does this service's log line
 * actually appear immediately after hiding the app) is the only way to
 * confirm which case this device falls into - not verified from a
 * sandbox with no real ColorOS device attached.
 */
class AccessibilityWatchdogService : Service() {

    private var contentObserver: ContentObserver? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildNotification())

        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                checkAndRestore()
            }
        }
        contentObserver = observer
        contentResolver.registerContentObserver(
            Settings.Secure.getUriFor(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES),
            false,
            observer,
        )

        // Cover the case where accessibility was already stripped before
        // this service (re)started - e.g. right after boot, before the
        // observer above has anything to react to yet.
        checkAndRestore()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    private fun checkAndRestore() {
        val serviceComponent = ComponentName(this, ContentGuardService::class.java)
        val flattened = serviceComponent.flattenToString()
        val current = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        val enabledComponents = current.split(':').filter { it.isNotBlank() }

        if (enabledComponents.any { it.equals(flattened, ignoreCase = true) }) {
            return
        }

        val restored = (enabledComponents + flattened).joinToString(":")
        try {
            Settings.Secure.putString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, restored)
            Settings.Secure.putInt(contentResolver, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
            val line = "restored $flattened to enabled_accessibility_services"
            Log.i(TAG, line)
            DebugLogBuffer.add(TAG, line)
        } catch (e: SecurityException) {
            Log.e(TAG, "WRITE_SECURE_SETTINGS not granted - cannot self-restore accessibility", e)
        }
    }

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Protection watchdog", NotificationManager.IMPORTANCE_MIN)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("Protection watchdog active")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        contentObserver?.let { contentResolver.unregisterContentObserver(it) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "AccessibilityWatchdog"
        private const val CHANNEL_ID = "accessibility_watchdog"
        private const val NOTIFICATION_ID = 1001

        fun start(context: Context) {
            val intent = Intent(context, AccessibilityWatchdogService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
