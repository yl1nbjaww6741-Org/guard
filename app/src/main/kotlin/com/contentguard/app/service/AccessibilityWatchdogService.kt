package com.contentguard.app.service

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.database.ContentObserver
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import com.contentguard.app.R
import com.contentguard.app.scope.PrefsRepository
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
 *
 * Also restores whatever's in [PrefsRepository.getExtraProtectedServices] -
 * other accessibility services (e.g. a separate screen-time app) the user
 * has explicitly opted into persisting from SecurityTab. Same mechanism,
 * same unconditional restore-if-missing behavior, just not limited to
 * ContentGuardService's own component.
 *
 * Also covers a second failure mode the ContentObserver above structurally
 * cannot see: `enabled_accessibility_services` staying correct the whole
 * time while the live binding behind it is dead anyway - confirmed on a
 * real device where nothing short of a full reboot brought blocking back,
 * even though the setting string never changed. Most likely cause is the OS
 * killing this app's whole process (ColorOS's aggressive background/power
 * management is the prime suspect - see docs/COLOROS.md) without the
 * accessibility subsystem cleanly deregistering the service first, so
 * there's nothing here for a ContentObserver to fire on. [checkHeartbeatAndKick]
 * is the fix: ContentGuardService stamps [PrefsRepository.lastHeartbeatAtMillis]
 * every few minutes for as long as it's genuinely alive, and a periodic
 * timer here (started from [onCreate], independent of the ContentObserver)
 * forces a rebind - toggling the setting off then back on, the same
 * WRITE_SECURE_SETTINGS mechanism as [checkAndRestore] - whenever that
 * stamp goes stale, even though nothing is missing from the enabled list.
 *
 * [WatchdogAlarmReceiver] is the backstop for the harder case this
 * in-process timer can't reach on its own: this service's own process
 * being the one that got killed. See that class's doc comment.
 */
class AccessibilityWatchdogService : Service() {

    private var contentObserver: ContentObserver? = null
    private val prefs by lazy { PrefsRepository(this) }
    private val handler = Handler(Looper.getMainLooper())
    private var lastKickAtElapsedRealtime = 0L

    private val heartbeatCheckRunnable = object : Runnable {
        override fun run() {
            checkHeartbeatAndKick()
            handler.postDelayed(this, HEARTBEAT_CHECK_INTERVAL_MS)
        }
    }

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

        // Idempotent - re-posting while a previous run's callback is still
        // queued (onCreate firing again after this same instance is
        // restarted by the OS) would otherwise stack a second ticking loop
        // alongside the first.
        handler.removeCallbacks(heartbeatCheckRunnable)
        handler.postDelayed(heartbeatCheckRunnable, HEARTBEAT_CHECK_INTERVAL_MS)

        // Defensive (re)schedule, same reasoning as ContentGuardService
        // starting this very service defensively in onServiceConnected:
        // covers this feature first shipping with no reboot in between, and
        // costs nothing to repeat since AlarmManager de-dupes by request
        // code/PendingIntent equality rather than stacking duplicates.
        scheduleWatchdogAlarm(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    private fun checkAndRestore() {
        val ownComponent = ComponentName(this, ContentGuardService::class.java).flattenToString()
        // Extra components are stored pre-flattened (see SecurityTab, which
        // captures them straight out of this same settings string when the
        // user opts a service in) - not reconstructed here, so there's no
        // risk of a flattenToString/flattenToShortString mismatch against
        // whatever form the OS actually stores.
        val watched = setOf(ownComponent) + prefs.getExtraProtectedServices()

        val current = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        val enabledComponents = current.split(':').filter { it.isNotBlank() }
        val enabledLower = enabledComponents.map { it.lowercase() }.toSet()

        val missing = watched.filterNot { it.lowercase() in enabledLower }
        if (missing.isEmpty()) {
            return
        }

        val restored = (enabledComponents + missing).joinToString(":")
        try {
            Settings.Secure.putString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, restored)
            Settings.Secure.putInt(contentResolver, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
            val line = "restored ${missing.joinToString(", ")} to enabled_accessibility_services"
            Log.i(TAG, line)
            DebugLogBuffer.add(TAG, line)
        } catch (e: SecurityException) {
            Log.e(TAG, "WRITE_SECURE_SETTINGS not granted - cannot self-restore accessibility", e)
        }
    }

    /**
     * The other half of this class's job - see the class doc comment for
     * why [checkAndRestore]'s ContentObserver can't see this failure mode.
     * A zero heartbeat means ContentGuardService has never connected since
     * this SharedPreferences value was last cleared (fresh install, or the
     * user genuinely turning accessibility off themselves) - nothing to
     * judge staleness against, so that's left alone rather than treated as
     * "stale" and kicked immediately.
     *
     * Cooldown-gated on [lastKickAtElapsedRealtime], not just on the
     * heartbeat itself going fresh again: a kick forces a rebind, which
     * takes ContentGuardService a real amount of time (a fresh ONNX session
     * load, among other things - see ContentGuardService.initializeOnce) to
     * reconnect and stamp a new heartbeat. Without this cooldown, a kick
     * whose rebind hadn't landed by the next timer tick would look just as
     * stale as before and trigger another kick immediately - toggling
     * `enabled_accessibility_services` in a tight loop instead of giving
     * one attempt a real chance to land. SystemClock.elapsedRealtime, not
     * wall-clock time, since it can't jump backwards on a clock change/NTP
     * sync mid-cooldown the way System.currentTimeMillis() could.
     */
    private fun checkHeartbeatAndKick() {
        val lastHeartbeat = prefs.lastHeartbeatAtMillis
        if (lastHeartbeat == 0L) return
        if (System.currentTimeMillis() - lastHeartbeat < HEARTBEAT_STALE_THRESHOLD_MS) return
        if (SystemClock.elapsedRealtime() - lastKickAtElapsedRealtime < KICK_COOLDOWN_MS) return

        val ownComponent = ComponentName(this, ContentGuardService::class.java).flattenToString()
        val current = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        val enabledComponents = current.split(':').filter { it.isNotBlank() }
        // Not actually enabled per the setting - checkAndRestore's own
        // missing-from-list path already owns this case (and will have
        // already fired, since both are driven off the same underlying
        // setting); nothing extra to do here.
        if (enabledComponents.none { it.equals(ownComponent, ignoreCase = true) }) return

        lastKickAtElapsedRealtime = SystemClock.elapsedRealtime()
        try {
            // Remove-then-restore rather than a no-op rewrite of the same
            // string: AccessibilityManagerService only re-evaluates and
            // rebinds a service when the setting value actually changes,
            // which is exactly why a dead binding can otherwise sit behind
            // an unchanged, technically-correct setting string forever (see
            // the class doc comment). This is the same restore mechanism as
            // checkAndRestore, just triggered by staleness instead of
            // absence.
            val withoutOwn = enabledComponents.filterNot { it.equals(ownComponent, ignoreCase = true) }.joinToString(":")
            Settings.Secure.putString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, withoutOwn)
            Settings.Secure.putString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, current)
            val line = "HEARTBEAT_STALE staleMs=${System.currentTimeMillis() - lastHeartbeat} - forced accessibility rebind"
            Log.i(TAG, line)
            DebugLogBuffer.add(TAG, line)
        } catch (e: SecurityException) {
            Log.e(TAG, "WRITE_SECURE_SETTINGS not granted - cannot force rebind on stale heartbeat", e)
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
        handler.removeCallbacks(heartbeatCheckRunnable)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "AccessibilityWatchdog"
        private const val CHANNEL_ID = "accessibility_watchdog"
        private const val NOTIFICATION_ID = 1001
        private const val ALARM_REQUEST_CODE = 2001

        // How often this service's own in-process timer re-checks the
        // heartbeat. Independent of ContentGuardService.HEARTBEAT_INTERVAL_MS
        // (how often that heartbeat is stamped) - this only needs to be
        // frequent enough that HEARTBEAT_STALE_THRESHOLD_MS gets noticed
        // reasonably promptly, not synchronized to the stamping cadence.
        private const val HEARTBEAT_CHECK_INTERVAL_MS = 10 * 60_000L

        // Generous multiple of ContentGuardService.HEARTBEAT_INTERVAL_MS
        // (5 min) - has to clear both ordinary scheduling jitter and a
        // Doze-deferred coroutine tick, not just the nominal interval,
        // without false-triggering a rebind on a service that's actually
        // fine.
        private const val HEARTBEAT_STALE_THRESHOLD_MS = 20 * 60_000L

        // Minimum time between two forced rebinds - see checkHeartbeatAndKick's
        // doc comment for why this can't just be "until the heartbeat looks
        // fresh again".
        private const val KICK_COOLDOWN_MS = 20 * 60_000L

        // Backstop interval for WatchdogAlarmReceiver - see its doc comment.
        // AlarmManager coalesces/defers inexact repeating alarms under Doze
        // regardless of what's requested here, so this is a target, not a
        // guarantee.
        private const val ALARM_INTERVAL_MS = 15 * 60_000L

        fun start(context: Context) {
            val intent = Intent(context, AccessibilityWatchdogService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /**
         * Schedules (or re-arms) the AlarmManager backstop that survives
         * this service's own process being killed - see
         * [WatchdogAlarmReceiver]'s doc comment. Inexact and repeating: this
         * is a periodic health check, not a time-critical alarm, so there's
         * no reason to pay Doze's exact-alarm battery cost or hold the
         * SCHEDULE_EXACT_ALARM permission for it. Safe to call repeatedly -
         * the same request code below means a later call replaces the
         * pending alarm rather than stacking a duplicate.
         */
        fun scheduleWatchdogAlarm(context: Context) {
            val alarmManager = context.getSystemService(AlarmManager::class.java) ?: return
            val intent = Intent(context, WatchdogAlarmReceiver::class.java)
            val pendingIntent = PendingIntent.getBroadcast(
                context,
                ALARM_REQUEST_CODE,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            alarmManager.setInexactRepeating(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + ALARM_INTERVAL_MS,
                ALARM_INTERVAL_MS,
                pendingIntent,
            )
        }
    }
}
