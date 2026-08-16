package com.contentguard.app.service

import android.accessibilityservice.AccessibilityService
import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo
import androidx.core.content.ContextCompat
import com.contentguard.app.capture.ScreenCapturer
import com.contentguard.app.detect.FrameDiffGate
import com.contentguard.app.detect.IncognitoDetector
import com.contentguard.app.detect.KeywordBlocklist
import com.contentguard.app.detect.NodeInspector
import com.contentguard.app.detect.NsfwClassifier
import com.contentguard.app.detect.NsfwClassifierFactory
import com.contentguard.app.detect.SecureContentDetector
import com.contentguard.app.detect.SkinTonePrefilter
import com.contentguard.app.overlay.BlurOverlayController
import com.contentguard.app.overlay.PasswordGuardOverlayController
import com.contentguard.app.scope.AppScopePolicy
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.util.DebugLogBuffer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.coroutineContext

/**
 * Orchestrates the whole gating cascade. Every stage funnels through a
 * single consumer coroutine fed by a CONFLATED channel: a new frame
 * request overwrites whatever the consumer hasn't gotten to yet, so under
 * event bursts (fast scrolling, rapid app switches) we only ever process
 * the latest screen state, never a backlog. There is exactly one
 * in-flight cascade run at a time.
 */
class ContentGuardService : AccessibilityService() {

    private lateinit var prefs: PrefsRepository
    private lateinit var scopePolicy: AppScopePolicy
    private lateinit var debouncer: EventDebouncer
    private lateinit var screenCapturer: ScreenCapturer
    private lateinit var nsfwClassifier: NsfwClassifier
    private lateinit var overlay: BlurOverlayController
    private lateinit var passwordGuardOverlay: PasswordGuardOverlayController
    private val frameDiffGate = FrameDiffGate()

    // Recreated by initializeOnce, not a val: onDestroy cancels this scope,
    // and a cancelled scope can never run another coroutine - launch() on it
    // is a silent no-op forever. Since initializeOnce is what launches both
    // detection loops, a scope that outlived its own cancellation would mean
    // the cascade never restarts. See onDestroy/initializeOnce.
    private var serviceScope = newServiceScope()
    private val frameChannel = Channel<FrameRequest>(Channel.CONFLATED)

    // Wakes recheckStaticContent out of its parked (screen-off) state. Fed by
    // screenStateReceiver on ACTION_SCREEN_ON/OFF; CONFLATED so a burst of
    // transitions collapses to a single pending wake and the loop never
    // builds a backlog of them. See recheckStaticContent for why the loop
    // parks entirely with the screen off instead of polling.
    private val screenStateChannel = Channel<Unit>(Channel.CONFLATED)

    private var lastForegroundPackage: String? = null
    private var settingsGuardUnlocked = false
    private var onGuardedSettingsScreen = false

    // Only touched from the single consumeFrames coroutine, so no
    // synchronization needed - see processFrame's pre-scan gate.
    private var lastTextScanAt = 0L

    // Pending debounced registry refresh - see registerPackageChangeReceiver.
    // Only touched from onReceive, which always runs on the main thread.
    private var registryRefreshJob: Job? = null

    // Guards the heavy, strictly-one-time setup in onServiceConnected against
    // that callback firing more than once on the same instance - see the
    // comment there and initializeOnce. Reset in onDestroy: this means "the
    // setup done by THIS live incarnation of the service is still standing,"
    // not "this process has ever run setup." Once onDestroy has torn that
    // setup down (cancelled scope, closed classifier session), a later
    // (re)connect must build it again or the cascade stays dead forever.
    private var oneTimeSetupDone = false

    // Registered in onServiceConnected, unregistered in onDestroy - see
    // there for why this replaces a periodic PackageManager poll for
    // keeping IncognitoDetector's dynamic browser set current.
    private var packageChangeReceiver: BroadcastReceiver? = null

    // Registered in onServiceConnected, unregistered in onDestroy. Turns the
    // screen-off period into a genuine indefinite sleep for the static-recheck
    // loop (zero wakeups) rather than a coarse poll - see registerScreenStateReceiver.
    private var screenStateReceiver: BroadcastReceiver? = null

    private val activityManager: ActivityManager by lazy { getSystemService(ActivityManager::class.java) }
    private val powerManager: PowerManager by lazy { getSystemService(PowerManager::class.java) }

    private data class FrameRequest(val packageName: String)

    override fun onServiceConnected() {
        super.onServiceConnected()
        // Defensive start - BootReceiver is the main entry point after a
        // reboot, but this covers the case where the watchdog isn't
        // already running yet (e.g. right after this feature first ships,
        // with no reboot in between). See AccessibilityWatchdogService's
        // doc comment for why it has to be a separate service.
        AccessibilityWatchdogService.start(applicationContext)

        // One-time per *live setup*, not once per process. onServiceConnected
        // can legitimately fire more than once on the SAME instance - Android
        // rebinds an AccessibilityService without necessarily calling
        // onDestroy first (see registerPackageChangeReceiver's doc), and the
        // watchdog re-enabling this service after ColorOS strips it drives
        // exactly such reconnects. Everything below this block is idempotent
        // or intentionally repeated per (re)connect, but initializeOnce must
        // not repeat while its previous run is still standing: without this
        // guard every reconnect built a fresh NsfwClassifier (another ~7MB
        // ONNX session, the previous one never closed - a native leak) and
        // launched another consumeFrames + recheckStaticContent on the
        // long-lived serviceScope. Those duplicate loops never stopped, so N
        // reconnects meant N detection loops all capturing screenshots and
        // running inference in parallel - escalating battery drain that grew
        // across a day of ordinary rebinds.
        //
        // The flag is cleared by onDestroy, which is what makes the opposite
        // failure impossible too: onDestroy cancels serviceScope and closes
        // the classifier, so a connect that skipped initializeOnce after a
        // teardown would leave the service apparently healthy (enabled,
        // overlays working, events arriving) with both detection loops gone
        // and launch() a permanent no-op on the cancelled scope - i.e.
        // nothing ever scored or blocked again until the process restarted.
        if (!oneTimeSetupDone) {
            // Set only on success. If setup throws part-way (a native ORT
            // load failure, say), latching the flag first would mean every
            // later reconnect skipped the retry and ran on half-initialized
            // lateinit state instead.
            initializeOnce()
            oneTimeSetupDone = true
        }

        // Populate immediately on (re)connect - covers anything installed
        // while the service wasn't running to receive the broadcast below
        // (disabled, force-stopped, or before the very first boot after
        // this feature shipped). Both receiver registrations are idempotent
        // (each unregisters any prior instance before re-registering).
        IncognitoDetector.refreshInstalledBrowsers(packageManager)
        AppScopePolicy.refreshInstalledLaunchers(packageManager)
        registerPackageChangeReceiver()
        registerScreenStateReceiver()

        // Re-evaluates every delay-before-unlock pending action every time
        // the service (re)connects - after a reboot, after being
        // force-stopped and relaunched, or just the OS rebinding it - so
        // any cooldown that finished while the process was dead still
        // takes effect promptly, without needing any new background
        // scheduler. See PrefsRepository.applyEligiblePendingWeakenActions's
        // doc comment.
        applyPendingWeakenActionIfDue()

        // Was Log.i-only (logcat, adb required) until this line's absence
        // turned out to matter: HEARTBEAT_STALE recoveries prove
        // AccessibilityWatchdogService (a live timer in this same process)
        // is what notices and fixes a dead ContentGuardService binding, not
        // a process restart - so a device with no adb access had no way to
        // see a reconnect happen at all, only its symptom (a heartbeat gap)
        // several minutes later via the watchdog's own line. Paired with
        // onDestroy/onInterrupt below now also writing here, the Debug log
        // card shows the full teardown/reconnect cycle with no adb needed.
        val connectedLine = "connected: mode=${prefs.mode} threshold=${prefs.nsfwThreshold}"
        Log.i(TAG, connectedLine)
        DebugLogBuffer.add(TAG, connectedLine)
    }

    /**
     * The heavy setup - creating the classifier (which loads the ONNX model
     * and opens a native session) and launching the two long-lived consumer
     * coroutines. Guarded by [oneTimeSetupDone] in onServiceConnected
     * precisely because that callback can fire repeatedly on a single
     * instance; running this again while the previous run is still standing
     * leaks a classifier session and stacks duplicate detection loops.
     *
     * Runs again (not "once per process") after an onDestroy has torn the
     * previous setup down - which is why it starts by replacing
     * [serviceScope]. onDestroy cancels that scope permanently; relaunching
     * the detection loops on the cancelled one would silently do nothing at
     * all, leaving a service that looks connected but never scores a frame.
     */
    private fun initializeOnce() {
        // Cancel-then-replace rather than reuse, and close any classifier
        // still open. Both are no-ops on the first connect, and both make
        // this method safely repeatable: the duplicate detection loops and
        // leaked ~7MB ONNX sessions that motivated the oneTimeSetupDone guard
        // in the first place are now structurally impossible here rather than
        // only prevented by that flag being correct. That matters for the one
        // case the flag alone doesn't cover - initializeOnce throwing
        // part-way, after the classifier exists but before the loops start,
        // which leaves the flag false so the next connect retries.
        serviceScope.cancel()
        serviceScope = newServiceScope()
        if (::nsfwClassifier.isInitialized) nsfwClassifier.close()

        prefs = PrefsRepository(applicationContext)
        scopePolicy = AppScopePolicy(prefs)
        debouncer = EventDebouncer()
        screenCapturer = ScreenCapturer(this, ContextCompat.getMainExecutor(this), prefs)
        nsfwClassifier = NsfwClassifierFactory.create(applicationContext)
        overlay = BlurOverlayController(
            service = this,
            onBackKeyPressed = {
                if (prefs.dismissOnBlock) {
                    serviceScope.launch(Dispatchers.Main) { dismissBlockedApp() }
                }
            },
            onOkTapped = {
                serviceScope.launch(Dispatchers.Main) { dismissBlockedApp() }
            },
        )
        passwordGuardOverlay = PasswordGuardOverlayController(
            service = this,
            onVerify = { entered -> prefs.verifyPassword(entered) },
            // A correct password doesn't always mean "grant access now" -
            // see settingsGuardCooldownMessageIfPending's doc comment for
            // why reaching Accessibility/Device admin/the ColorOS battery
            // page needs the same anti-impulse cooldown as everything else
            // delay-before-unlock covers, and why it can't be modeled as a
            // deferred PendingWeakenAction the way in-app settings are.
            onUnlocked = {
                if (!prefs.delayBeforeUnlockEnabled) {
                    settingsGuardUnlocked = true
                } else {
                    val now = System.currentTimeMillis()
                    var eligibleAt = prefs.settingsGuardCooldownEligibleAtMillis
                    if (eligibleAt == 0L) {
                        eligibleAt = now + prefs.delayBeforeUnlockMinutes * 60_000L
                        prefs.settingsGuardCooldownEligibleAtMillis = eligibleAt
                        val line = "SETTINGS_GUARD_COOLDOWN_STARTED eligibleAt=$eligibleAt"
                        Log.i(TAG, line)
                        DebugLogBuffer.add(TAG, line)
                    }
                    if (now >= eligibleAt) {
                        prefs.clearSettingsGuardCooldown()
                        settingsGuardUnlocked = true
                    } else {
                        passwordGuardOverlay.showCooldown(formatCooldownRemaining(eligibleAt - now))
                    }
                }
            },
            onCancelled = { performGlobalAction(GLOBAL_ACTION_HOME) },
            // "I entered the password but changed my mind" - discards the
            // running cooldown outright rather than leaving it to keep
            // ticking in the background. Never itself password-gated: like
            // every other Cancel in this app, giving up on a change is
            // always the safe direction.
            onCancelCooldown = {
                prefs.clearSettingsGuardCooldown()
                val line = "SETTINGS_GUARD_COOLDOWN_CANCELLED"
                Log.i(TAG, line)
                DebugLogBuffer.add(TAG, line)
                performGlobalAction(GLOBAL_ACTION_HOME)
            },
        )

        serviceScope.launch { consumeFrames() }
        serviceScope.launch { recheckStaticContent() }
        serviceScope.launch { heartbeatLoop() }
    }

    /**
     * Stamps prefs.lastHeartbeatAtMillis every HEARTBEAT_INTERVAL_MS for as
     * long as this live setup stands - see that field's doc comment for why
     * it exists (AccessibilityWatchdogService's own ContentObserver has
     * nothing to react to when the live binding dies without the
     * `enabled_accessibility_services` string itself changing). Runs
     * unconditionally, screen on or off - unlike recheckStaticContent this
     * has nothing to do with what's on screen, only with proving the
     * service's own coroutines are still scheduling work at all, so parking
     * it with the display off would defeat the point: a dead process is
     * exactly as dead overnight as it is at 2pm. A single Long SharedPreferences
     * write every few minutes is not worth gating behind anything.
     */
    private suspend fun heartbeatLoop() {
        while (coroutineContext.isActive) {
            prefs.lastHeartbeatAtMillis = System.currentTimeMillis()
            delay(HEARTBEAT_INTERVAL_MS)
        }
    }

    /**
     * Keeps IncognitoDetector's dynamic browser set current by reacting to
     * new app installs, instead of re-querying PackageManager on a periodic
     * timer regardless of whether anything changed. Updates of already-
     * installed apps are deliberately ignored (see the receiver body) - only
     * a first-time install can change which apps are browsers, and app
     * updates otherwise fire constantly (Play Store auto-update) for no
     * registry-relevant reason. ACTION_PACKAGE_ADDED is a protected system
     * broadcast - only the OS itself can send it, so RECEIVER_NOT_EXPORTED
     * (no other app needs to be able to trigger this) is the correct,
     * narrower flag Android 13+ requires an explicit choice on. Registered
     * here (not the manifest):
     * a context-registered receiver isn't subject to the Android 8+
     * restriction on manifest-declared implicit-broadcast receivers, and
     * this only ever needs to exist while the service itself is alive.
     *
     * Idempotent: onServiceConnected() (which calls this) can legitimately
     * fire more than once per process - Android rebinds an
     * AccessibilityService without necessarily tearing it down first - so
     * this unregisters whatever was already registered before creating a
     * new one. Without that, each rebind would leak one more permanently-
     * registered receiver, all still firing (and each re-querying
     * PackageManager) on every future install alongside each other.
     */
    private fun registerPackageChangeReceiver() {
        packageChangeReceiver?.let { unregisterReceiver(it) }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                // Only react to genuinely new installs, not updates of
                // already-installed apps. An update fires ACTION_PACKAGE_ADDED
                // too, but with EXTRA_REPLACING=true (the same broadcast a
                // fresh install sends without that extra) - and a Play Store
                // auto-update storm is exactly that: dozens of REPLACING adds
                // for apps we already know about. "Which apps are browsers"
                // can't change on a plain version bump of an app that's
                // already installed, so a replace carries no new registry
                // information; skip it and let the debounced refresh fire only
                // when a package that wasn't here before appears. (The rare
                // case where an update *adds* a browser intent filter to an
                // existing app is still picked up on the next service
                // (re)connect refresh, and BROWSER_PACKAGES' hand-maintained
                // floor covers every well-known browser regardless.)
                if (intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)) return

                // Off the main thread - queryIntentActivities is a Binder
                // call into PackageManagerService that walks every
                // installed app's manifest, not free enough to run
                // synchronously on the thread onReceive() is dispatched on.
                // Safe to fire-and-forget here specifically: this process
                // already stays alive via the accessibility service binding
                // and AccessibilityWatchdogService's own foreground service,
                // so there's no risk of the process being reclaimed before
                // this coroutine finishes the way there would be for an
                // ordinary short-lived receiver.
                //
                // Debounced, not refreshed per broadcast: new installs can
                // still arrive in bursts (e.g. restoring a device, or a batch
                // of sideloaded APKs), and one wake + two PackageManager walks
                // per package adds up. Restarting the delay on each broadcast
                // collapses a whole burst into one refresh shortly after its
                // last install. Worst case for the delay: a browser installed
                // and opened within the debounce window isn't recognized as
                // one for a few seconds - BROWSER_PACKAGES' hand-maintained
                // floor still covers every well-known browser immediately.
                registryRefreshJob?.cancel()
                registryRefreshJob = serviceScope.launch(Dispatchers.Default) {
                    delay(REGISTRY_REFRESH_DEBOUNCE_MS)
                    IncognitoDetector.refreshInstalledBrowsers(packageManager)
                    AppScopePolicy.refreshInstalledLaunchers(packageManager)
                }
            }
        }
        packageChangeReceiver = receiver
        // Only ACTION_PACKAGE_ADDED - not ACTION_PACKAGE_REPLACED. A replace
        // (app update) never introduces a package we didn't already know
        // about, so it can't change which apps are browsers/launchers; the
        // EXTRA_REPLACING guard in onReceive additionally drops the ADDED
        // broadcast that an update fires alongside REPLACED, leaving only
        // genuine first-time installs to trigger a registry refresh.
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addDataScheme("package")
        }
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    /**
     * Lets recheckStaticContent sleep indefinitely while the display is off
     * instead of waking on a timer to find nothing to do. ACTION_SCREEN_ON/
     * ACTION_SCREEN_OFF are protected system broadcasts (only the OS sends
     * them) and, unlike most implicit broadcasts, *must* be registered
     * dynamically at runtime - a manifest-declared receiver never receives
     * them at all - so a context-registered receiver that lives exactly as
     * long as the service is the only option regardless of the Android 8+
     * manifest-broadcast restrictions. RECEIVER_NOT_EXPORTED because no other
     * app has any business delivering these to us.
     *
     * Every transition just nudges [screenStateChannel]; the loop re-reads
     * powerManager.isInteractive itself to decide what to do, so a spurious
     * or coalesced wake is harmless. Idempotent for the same reason
     * registerPackageChangeReceiver is - onServiceConnected can fire more
     * than once per process, so unregister any prior receiver first to avoid
     * leaking one per rebind.
     */
    private fun registerScreenStateReceiver() {
        screenStateReceiver?.let { unregisterReceiver(it) }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                screenStateChannel.trySend(Unit)
            }
        }
        screenStateReceiver = receiver
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
        }
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    private fun applyPendingWeakenActionIfDue() {
        val applied = prefs.applyEligiblePendingWeakenActions()
        applied.forEach { action ->
            val line = "PENDING_UNLOCK_APPLIED action=$action"
            Log.i(TAG, line)
            DebugLogBuffer.add(TAG, line)
        }
    }

    /**
     * Is the guarded-Settings screen (Accessibility, Device admin, the
     * ColorOS battery/Force-stop page) actually reachable right now? True
     * once a password has been verified this visit (settingsGuardUnlocked),
     * or - the delay-before-unlock case - once a cooldown that was already
     * started by an earlier correct password has now elapsed, in which case
     * this auto-consumes it (clears the cooldown, sets settingsGuardUnlocked)
     * so nothing further is needed from the user.
     */
    private fun settingsGuardEffectivelyUnlocked(): Boolean {
        if (settingsGuardUnlocked) return true
        // A stale cooldown from before the feature was turned off must not
        // keep gating access once it's disabled - otherwise turning delay-
        // before-unlock off wouldn't actually restore today's instant
        // behavior until whatever cooldown happened to be running finished.
        if (!prefs.delayBeforeUnlockEnabled) return false
        val eligibleAt = prefs.settingsGuardCooldownEligibleAtMillis
        if (eligibleAt != 0L && System.currentTimeMillis() >= eligibleAt) {
            prefs.clearSettingsGuardCooldown()
            settingsGuardUnlocked = true
            val line = "SETTINGS_GUARD_COOLDOWN_ELAPSED - screen unlocked"
            Log.i(TAG, line)
            DebugLogBuffer.add(TAG, line)
            return true
        }
        return false
    }

    /**
     * Non-null only when a cooldown from an earlier correct password is
     * already running and hasn't elapsed - lets the guard trigger skip
     * straight to the "still waiting" message instead of asking for the
     * password again just to reach the same answer. Read-only: unlike
     * settingsGuardEffectivelyUnlocked(), this never starts or consumes the
     * cooldown itself.
     */
    private fun settingsGuardCooldownMessageIfPending(): String? {
        if (!prefs.delayBeforeUnlockEnabled) return null
        val eligibleAt = prefs.settingsGuardCooldownEligibleAtMillis
        if (eligibleAt == 0L) return null
        val remaining = eligibleAt - System.currentTimeMillis()
        return if (remaining > 0) formatCooldownRemaining(remaining) else null
    }

    private fun formatCooldownRemaining(ms: Long): String {
        val totalSeconds = ms / 1000
        val hours = totalSeconds / 3600
        val minutes = (totalSeconds % 3600) / 60
        val seconds = totalSeconds % 60
        val remainingLabel = when {
            hours > 0 -> "%dh %02dm".format(hours, minutes)
            minutes > 0 -> "%dm %02ds".format(minutes, seconds)
            else -> "%ds".format(seconds)
        }
        return "Correct - this screen unlocks in $remainingLabel."
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val packageName = event.packageName?.toString() ?: return

        // The on-screen keyboard opening/closing fires its own
        // TYPE_WINDOW_STATE_CHANGED with its own package - not a real app
        // switch. Without this check, that event set lastForegroundPackage
        // to the IME's package, and the periodic static-content recheck
        // then spent seconds re-querying the keyboard instead of whatever
        // app (and image) was actually still on screen underneath it. Real
        // app activities report as TYPE_APPLICATION; IME/system/overlay
        // windows don't.
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && !isApplicationWindow(event.windowId)) {
            return
        }

        val isRealAppSwitch = event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            packageName != lastForegroundPackage &&
            !scopePolicy.isHardExcluded(packageName)

        if (isRealAppSwitch) {
            lastForegroundPackage = packageName
            if (packageName != SETTINGS_PACKAGE && packageName != OPLUS_BATTERY_PACKAGE) {
                settingsGuardUnlocked = false
                onGuardedSettingsScreen = false
            }
            if (overlay.isVisible() && !prefs.isLockedOut(packageName)) {
                serviceScope.launch(Dispatchers.Main) { overlay.hide() }
            }
        }

        // Keyed on the window's own title (from the TYPE_WINDOW_STATE_CHANGED
        // event), not a scan of all visible text - scanning all text was
        // matching "Device admin apps" wherever that phrase appeared,
        // including as a search-suggestion chip on Settings' own search
        // screen, which isn't the real screen at all.
        if (packageName == SETTINGS_PACKAGE && event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val screenTitle = event.text.joinToString(" ").lowercase()
            onGuardedSettingsScreen = GUARDED_SETTINGS_TITLE_MARKERS.any { screenTitle.contains(it) }
        }

        // OPLUS_BATTERY_PACKAGE can't use the title check above - real-
        // device logging (GATE_SETTINGS_GUARD_DEBUG, added specifically to
        // check this rather than guess again) found this screen's own
        // window title is just the generic "Battery", shared by every
        // app's battery page, not distinctive text like "Device admin
        // apps" or "ContentGuard". Falls back to scanning the screen's
        // actual visible content for the app's own name instead, the same
        // way gate 4's content check works when a title alone isn't enough
        // to tell screens apart.
        if (packageName == OPLUS_BATTERY_PACKAGE && event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val root = rootInActiveWindow
            val screenText = NodeInspector.scan(root).visibleText.lowercase()
            @Suppress("DEPRECATION")
            root?.recycle()
            onGuardedSettingsScreen = screenText.contains("contentguard")
        }

        if ((packageName == SETTINGS_PACKAGE || packageName == OPLUS_BATTERY_PACKAGE) &&
            onGuardedSettingsScreen && prefs.hasPassword() && !settingsGuardEffectivelyUnlocked()
        ) {
            if (!passwordGuardOverlay.isVisible()) {
                val line = "[$packageName] exit@GATE_SETTINGS_GUARD"
                Log.i(TAG, line)
                DebugLogBuffer.add(TAG, line)
                // If a cooldown from an earlier correct password is already
                // running, go straight to that message - it's already been
                // proven correct once; no need to ask again just to show
                // the same "not yet" answer.
                val cooldownMessage = settingsGuardCooldownMessageIfPending()
                serviceScope.launch(Dispatchers.Main) { passwordGuardOverlay.show(cooldownMessage) }
            }
            return
        }

        if (prefs.isLockedOut(packageName)) {
            // Gate on overlay visibility, not isRealAppSwitch: the 3rd
            // strike usually fires while the user is already inside the
            // offending app (no app-switch event ever occurs), so keying
            // off isRealAppSwitch alone left the lockout invisible unless
            // the user happened to leave and come back. Any event in a
            // locked-out package re-shows the block whenever it isn't
            // already up - including right after the user dismisses it
            // and stays put, which is exactly when it must persist.
            if (!overlay.isVisible()) {
                val line = "[$packageName] exit@GATE0_LOCKED_OUT"
                Log.i(TAG, line)
                DebugLogBuffer.add(TAG, line)
                serviceScope.launch(Dispatchers.Main) { overlay.show(packageName) }
            }
            return
        }

        if (!scopePolicy.shouldMonitor(packageName)) {
            if (prefs.verboseLogging) Log.d(TAG, "[$packageName] exit@GATE1_WHITELIST")
            return
        }

        // Restricted to known browser packages so this can never trigger
        // on an unrelated app (Gboard's own "Incognito mode" privacy
        // indicator was matching here before that restriction was added -
        // see IncognitoDetector's doc comment). Confirmed correct against
        // real on-device titles: a regular tab reports e.g. "Chrome: New
        // tab" (no match) while an incognito tab reports "Chrome: New
        // Incognito tab" (matches) - the window's own title, a single
        // short string, isn't at risk of the whole-tree concatenation
        // false positives that affected the content-based check earlier.
        if (IncognitoDetector.isBrowserPackage(packageName) &&
            event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        ) {
            val windowTitle = event.text.joinToString(" ")
            if (IncognitoDetector.matchesTitle(windowTitle)) {
                if (!overlay.isVisible()) {
                    val line = "[$packageName] exit@GATE4_INCOGNITO_DETECTED title=\"$windowTitle\""
                    Log.i(TAG, line)
                    DebugLogBuffer.add(TAG, line)
                    serviceScope.launch(Dispatchers.Main) { overlay.show(packageName) }
                }
                return
            }
        }

        // A block overlay is already displayed for this app. While it's up,
        // nothing the cascade could decide changes what's on screen:
        // exitSafe() deliberately never hides the overlay (see its doc), and
        // every overlay.show() path no-ops when it's already visible. So
        // capturing a screenshot and running inference behind it - which the
        // content still churning underneath (autoplay, rotating ads,
        // infinite scroll) would otherwise trigger every cycle - is pure
        // wasted battery with no possible effect. The overlay only ever comes
        // down via a real app switch (handled at the top of this method) or
        // the user dismissing it, neither of which needs the cascade running.
        // Locked-out and settings-guard cases already returned above; this
        // covers the ordinary post-block case.
        //
        // Excludes a real app switch: that already requested overlay.hide()
        // above, but hide() runs on the main dispatcher after this handler
        // returns, so isVisible() is still true here - skipping on the switch
        // event itself would drop the first frame for the app just opened and
        // delay evaluating it until its next event or the static recheck. A
        // non-switch event (content changing behind a still-standing block)
        // is exactly the case to skip.
        if (overlay.isVisible() && !isRealAppSwitch) return

        if (!debouncer.shouldProcess(event)) {
            if (prefs.verboseLogging) Log.d(TAG, "[$packageName] exit@GATE2_DEBOUNCE")
            return
        }

        // CONFLATED: overwrites any request the consumer hasn't picked up yet.
        frameChannel.trySend(FrameRequest(packageName))
    }

    /**
     * The single consumer of [frameChannel]. There is exactly one of these,
     * and nothing restarts it, so it must survive anything a single frame can
     * throw: if this loop ever exits, no frame is scored again for the life of
     * the process and the app goes silently non-blocking.
     *
     * Catches Throwable rather than Exception deliberately. The work below is
     * native-backed (ONNX Runtime) and allocation-heavy (full-resolution
     * screenshot bitmaps), and NodeInspector's tree walk is recursive - so
     * OutOfMemoryError, UnsatisfiedLinkError and StackOverflowError are all
     * reachable here, and none of them is an Exception. One of those on one
     * bad frame must cost that frame, not the whole cascade.
     *
     * withTimeout wraps processFrame itself, not just its individual
     * suspend points (see ScreenCapturer.takeScreenshotSuspending's own
     * timeout fix for the specific hang a real-device report traced to) -
     * a defensive backstop against any *other* suspend point in the gate
     * cascade someday hanging the same way: a permanently-suspended
     * coroutine here throws nothing at all, so without a bound, that one
     * request wedges the sole consumer of frameChannel forever, silently
     * killing every gate downstream of capture (4B/5/5B/6/7/8) for the rest
     * of the process's life while gates evaluated directly in
     * onAccessibilityEvent (GATE_SETTINGS_GUARD, incognito's title check)
     * keep working fine - exactly the split that report showed, with
     * nothing in any log to explain it because nothing ever threw.
     *
     * A timeout here is a TimeoutCancellationException, a CancellationException
     * subtype - which the catch below must NOT treat the same as
     * serviceScope actually being cancelled in onDestroy, or a single slow
     * frame would silently end this loop exactly like the bug being fixed.
     * coroutineContext.isActive distinguishes them: still true means only
     * this frame's own withTimeout fired, not the outer scope, so it's safe
     * to log and move on to the next request; false means the real
     * cancellation from onDestroy, which must propagate to actually end the
     * loop.
     */
    private suspend fun consumeFrames() {
        for (request in frameChannel) {
            try {
                withTimeout(PROCESS_FRAME_TIMEOUT_MS) { processFrame(request) }
            } catch (e: CancellationException) {
                if (!coroutineContext.isActive) throw e
                Log.e(TAG, "processFrame timed out for ${request.packageName}", e)
                DebugLogBuffer.add(TAG, "[${request.packageName}] CASCADE_TIMEOUT after ${PROCESS_FRAME_TIMEOUT_MS}ms")
            } catch (t: Throwable) {
                Log.e(TAG, "cascade error for ${request.packageName}", t)
                DebugLogBuffer.add(TAG, "[${request.packageName}] CASCADE_ERROR ${t.javaClass.simpleName}: ${t.message}")
            }
        }
    }

    /**
     * The cascade is otherwise purely event-driven - it only runs when an
     * AccessibilityEvent fires (scroll, content change, app switch). A user
     * static on an already-rendered image generates no further events at
     * all, so real content could sit on screen indefinitely without ever
     * being re-scanned. This periodically re-queues a frame for whatever
     * app is currently foreground, independent of events, so dwelling on
     * static content still gets caught. Interval is prefs.staticRecheckIntervalMs
     * (derived from the user-tunable capture cadence in Settings, see
     * PrefsRepository), not a fixed constant. CONFLATED channel + ScreenCapturer's
     * own throttle mean redundant ticks are cheap while the screen is
     * genuinely in use - they exit at GATE4_TEXT_SCAN_THROTTLED (or, once
     * past that, GATE5_CAPTURE_THROTTLED) when a real event already
     * triggered a capture/text scan recently. Skips entirely
     * while the screen is off (see the isInteractive check below) - that's
     * the loop's main real battery cost, since it otherwise runs on this
     * timer 24/7 regardless of whether anything is actually on screen to
     * protect against.
     *
     * Deliberately queries rootInActiveWindow fresh on every tick instead
     * of reusing lastForegroundPackage - that field is only as reliable as
     * the event stream driving it, and real testing found brief,
     * legitimate-looking TYPE_APPLICATION window events for other packages
     * (the IME opening/closing; a partial gesture-nav swipe briefly
     * showing the launcher behind the current app) hijacking it for
     * seconds at a time, during which this recheck kept re-querying the
     * wrong app entirely while real content sat unscanned underneath.
     * Asking the OS what's actually active right now sidesteps that whole
     * class of bug rather than trying to enumerate every spurious source.
     *
     * Also applies the same isApplicationWindow check onAccessibilityEvent
     * already does, which this loop was missing entirely - rootInActiveWindow
     * isn't restricted to TYPE_APPLICATION, and real-device logs showed the
     * IME's own window (com.google.android.inputmethod.latin) repeatedly
     * becoming "the active window" from typing alone, with no app ever
     * opened, getting captured and scored every tick as a result.
     */
    private suspend fun recheckStaticContent() {
        // The coroutine's own job, not serviceScope's - serviceScope is
        // replaced wholesale on re-initialization (see initializeOnce), and a
        // loop left over from a previous incarnation must end when *its* scope
        // was cancelled, not keep running because a newer scope is active.
        while (coroutineContext.isActive) {
            try {
                recheckStaticContentTick()
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                // Same reasoning as consumeFrames: nothing restarts this
                // backstop, so a single failing tick (a binder failure from
                // rootInActiveWindow/windows while an app is dying, say) must
                // not be able to end it. Without this the periodic recheck -
                // the only thing that catches content the user simply dwells
                // on, generating no further events - could stop for good.
                Log.e(TAG, "static recheck tick failed", t)
                DebugLogBuffer.add(TAG, "STATIC_RECHECK_ERROR ${t.javaClass.simpleName}: ${t.message}")
                // Fixed constant, not prefs.staticRecheckIntervalMs: a tick
                // that failed while reading prefs would throw again here, out
                // of the catch block, and end the loop - the exact outcome
                // this whole guard exists to prevent. A failing tick also
                // hasn't necessarily reached its own delay, so without a
                // pause here the loop could hot-spin on a persistent fault.
                delay(RECHECK_ERROR_BACKOFF_MS)
            }
        }
    }

    /**
     * One iteration of [recheckStaticContent]; see that method's doc comment.
     * Extracted so a failing tick can be caught and the loop kept alive -
     * every early exit that was a `continue` in the loop is a `return` here,
     * with identical meaning (skip the rest of this tick, go round again).
     */
    private suspend fun recheckStaticContentTick() {
        // Screen off: park the loop entirely rather than poll. Unlike
        // onAccessibilityEvent (naturally quiet with the screen off, since
        // no window-state changes occur), this loop is timer-driven, and
        // accessibility services aren't Doze-throttled the way ordinary
        // apps are - so a plain timer here would keep waking the CPU 24/7
        // through every pocket/overnight stretch just to find nothing on
        // screen to scan. There is no reason to run at all while the
        // display is off: nothing is capturable, and a delay-before-unlock
        // cooldown only has any observable effect once the screen is back
        // on anyway (it changes future gating, and nothing is gated while
        // the screen is off). So we suspend on screenStateChannel until
        // the ACTION_SCREEN_ON receiver wakes us, contributing zero
        // wakeups meanwhile, then apply any now-due pending actions the
        // instant we wake - onServiceConnected also applies them on every
        // (re)connect, so nothing is missed across the sleep. receive()
        // throwing on serviceScope cancellation is the intended shutdown
        // path (the while-isActive loop simply ends).
        if (!powerManager.isInteractive) {
            // Nothing will accumulate while parked, so persist any
            // batched usage-stat deltas before the indefinite sleep -
            // this plus onDestroy bounds how long they stay memory-only.
            prefs.flushUsageStats()
            screenStateChannel.receive()
            applyPendingWeakenActionIfDue()
            return
        }

        // Screen on: pace the backstop at the on-screen interval. The
        // delay is at the top of this branch (not the bottom) because the
        // several early returns below would otherwise skip it and spin. The
        // screen can turn off during this delay, so re-read isInteractive
        // afterward and route back to the park above if it did -
        // rootInActiveWindow can still report the last-foreground app
        // after the screen turns off, so this check has to happen before
        // any capture is attempted rather than relying on ScreenCapturer's
        // own throttle (1800ms, shorter than this interval) to make it cheap.
        delay(prefs.staticRecheckIntervalMs)
        applyPendingWeakenActionIfDue()
        if (!powerManager.isInteractive) return

        // Same reason the event path skips while a block overlay is up
        // (see onAccessibilityEvent): re-capturing and re-classifying
        // behind an already-displayed block can't change what's shown, so
        // this timer would just be paying for a screenshot + inference
        // every tick to no effect. Without this the static-recheck loop
        // kept the cascade running behind every block the whole time it
        // stayed on screen. Checked before the rootInActiveWindow/windows
        // queries below - it's a plain in-process boolean, and the two
        // window queries are both binder calls there's no point paying
        // while a block is up.
        if (overlay.isVisible()) return

        val root = rootInActiveWindow
        val pkg = root?.packageName?.toString()
        val windowId = root?.windowId
        @Suppress("DEPRECATION")
        root?.recycle()
        if (pkg == null) return
        // Same defense onAccessibilityEvent already applies to the
        // event-driven path (see the IME-hijacking comment above) - it
        // was missing here. rootInActiveWindow isn't limited to
        // TYPE_APPLICATION windows, and an IME window (Gboard etc.) can
        // genuinely become "the active window" while it has input
        // focus, not just via a spurious event - real-device logs
        // showed this loop repeatedly queuing and scoring
        // com.google.android.inputmethod.latin every ~2s purely from
        // typing, with no app ever opened. A keyboard's own window is
        // never content worth scoring regardless of scope mode.
        if (windowId != null && !isApplicationWindow(windowId)) return
        if (onGuardedSettingsScreen || prefs.isLockedOut(pkg) || !scopePolicy.shouldMonitor(pkg)) return
        frameChannel.trySend(FrameRequest(pkg))
    }

    private suspend fun processFrame(request: FrameRequest) {
        val pkg = request.packageName

        // When the capture throttle guarantees gate 5 would drop this frame
        // anyway, the tree walk below is still worth running for gate 4b
        // alone - explicit-keyword matching (scan.visibleText) runs in
        // every monitored app, against whatever's rendered on screen, so it
        // needs the walk regardless of whether an image capture happens
        // this cycle. Only skip the walk when BOTH a capture would be
        // throttled AND a text scan has already run recently enough - paced
        // to prefs.textScanIntervalMs, its own independent Rules-tab slider
        // (see PrefsRepository) rather than tied to the capture-cadence
        // one - rendered text doesn't need the same near-instant response a
        // live keystroke does, so it can be paced much more loosely without
        // materially hurting detection. Without this pacing, every
        // debounced event (as often as every 100ms during a scroll) would
        // re-walk the tree - hundreds of binder calls into the foreground
        // app's process - just to recheck text that almost certainly hasn't
        // changed since the last walk. The event-side *title* check in
        // onAccessibilityEvent is untouched by this - it's a plain string
        // match with no walk, so title-based incognito detection stays
        // instant.
        if (screenCapturer.wouldThrottle() &&
            SystemClock.elapsedRealtime() - lastTextScanAt < prefs.textScanIntervalMs
        ) {
            exitSafe(pkg, "GATE4_TEXT_SCAN_THROTTLED")
            return
        }

        val root = rootInActiveWindow
        if (root == null) {
            exitSafe(pkg, "GATE_NO_ROOT")
            return
        }
        val scan = try {
            NodeInspector.scan(root)
        } finally {
            @Suppress("DEPRECATION")
            root.recycle()
        }
        // Stamped after any completed walk (capture-bound or text-only
        // alike) - it's what the pre-scan gate above paces between-capture
        // text scans against.
        lastTextScanAt = SystemClock.elapsedRealtime()
        // Counted separately from screenshots/inferences - see
        // PrefsRepository.UsageStats.nodeWalkCount's doc comment for why:
        // this is the operation gate 4b's app-wide scope made more frequent,
        // and it's cheap enough that the screenshot/inference counters alone
        // would never show it moving.
        prefs.recordNodeWalk()

        // Lowercased once here, not inside each matcher - matchingContentKeyword
        // below and KeywordBlocklist.matchingKeyword right after it are both
        // called against this same string in a browser, and each doing its
        // own .lowercase() on it was pure duplicate work every walk. Cheap
        // either way now that visibleText is capped (see NodeInspector's
        // MAX_VISIBLE_TEXT_CHARS), but free to only pay once.
        val visibleTextLower = scan.visibleText.lowercase()

        // Fallback for when the window-title check in onAccessibilityEvent
        // didn't catch it (e.g. the title only changes on the initial
        // window-state-change and a private tab's *content* wasn't loaded
        // yet at that point). Restricted to known browser packages and to
        // the narrower CONTENT_KEYWORDS set - see IncognitoDetector's doc
        // comment for why the whole-tree scan can't safely use the same
        // bare "incognito" keyword the title check does. Checked before
        // GATE3's image-content check, deliberately - this blocks private
        // browsing outright regardless of whether there's an image on
        // screen at all, since capture (gates 5-7) structurally cannot see
        // into a FLAG_SECURE window anyway.
        val matchedContentKeyword = if (IncognitoDetector.isBrowserPackage(pkg)) {
            IncognitoDetector.matchingContentKeyword(visibleTextLower)
        } else {
            null
        }
        if (matchedContentKeyword != null) {
            // Logs which keyword matched, not just that gate 4 fired - if this
            // is ever a false positive on an ordinary (non-incognito) tab, the
            // log immediately says what tripped it instead of leaving another
            // unexplained "Chrome fully blocked" report to re-investigate from
            // scratch (see IncognitoDetector's doc comment).
            if (!overlay.isVisible()) {
                val line = "[$pkg] exit@GATE4_INCOGNITO_DETECTED content keyword=\"$matchedContentKeyword\""
                Log.i(TAG, line)
                DebugLogBuffer.add(TAG, line)
                withContext(Dispatchers.Main) { overlay.show(pkg) }
            }
            return
        }

        // Blocks on explicit content rendered anywhere on screen, in any
        // monitored app - a page, a post, a caption, a title - not just
        // what's typed. Matches scan.visibleText (the same whole-page text
        // the incognito content-check above uses) against the full
        // EXPLICIT_KEYWORDS list. See KeywordBlocklist's doc comment for why
        // this deliberately trades some of the narrower, input-field-only
        // version's precision for catching content reached by tapping or
        // scrolling, not just search - and for the false-positive risk that
        // trade knowingly accepts. Checked before GATE3 for the same reason
        // as the incognito check above - this blocks outright regardless of
        // whether an image is on screen (a page can be explicit in text
        // alone, before or without any image ever loading).
        //
        // Not restricted to IncognitoDetector.BROWSER_PACKAGES - runs in
        // every monitored app, so a Reddit post title, an Instagram
        // caption, or a Play Store listing matches exactly the same as a
        // browser tab does.
        val matchedExplicitKeyword = KeywordBlocklist.matchingKeyword(visibleTextLower, prefs.getExplicitKeywords())
        if (matchedExplicitKeyword != null) {
            if (!overlay.isVisible()) {
                val line = "[$pkg] exit@GATE4B_KEYWORD_BLOCKED keyword=\"$matchedExplicitKeyword\""
                Log.i(TAG, line)
                DebugLogBuffer.add(TAG, line)
                withContext(Dispatchers.Main) { overlay.show(pkg) }
            }
            return
        }

        if (!scan.hasImages) {
            exitSafe(pkg, "GATE3_NO_IMAGE_NODES")
            return
        }

        // Crop to the union of detected image regions at capture time, not
        // after the whole-frame downscale - cropping post-downscale (an
        // earlier version of this cascade did that) means a small feed
        // thumbnail has already been squeezed through a low-res
        // intermediate step before the crop even happens, throwing away
        // exactly the detail the classifier needs to read it confidently.
        // Cropping the native-resolution screenshot first lets a small
        // region stay near its real resolution instead.
        val cropRegion = unionOf(scan.imageBounds)

        val captureStartNanos = System.nanoTime()
        val capture = screenCapturer.captureDownscaled(cropRegion = cropRegion)
        val captureMs = (System.nanoTime() - captureStartNanos) / 1_000_000
        val bitmap = when (capture) {
            // Routine and constant - the throttle doing its job. Verbose-only,
            // like every other nothing-to-report gate exit.
            is ScreenCapturer.CaptureResult.Throttled -> {
                exitSafe(pkg, "GATE5_CAPTURE_THROTTLED")
                return
            }
            // Logged unconditionally, unlike the throttle above: this means
            // the cascade is blind for this frame, and a sustained run of it
            // (an OEM skin denying screenshots to accessibility services)
            // means the app is silently protecting nothing while still
            // looking healthy. That is exactly the class of failure worth
            // seeing in the Debug log without having to enable verbose
            // logging first. Safe to log every time now that a failed attempt
            // advances the capture throttle (see ScreenCapturer), which bounds
            // this to at most one line per captureThrottleMs.
            is ScreenCapturer.CaptureResult.Failed -> {
                val line = "[$pkg] exit@GATE5_CAPTURE_FAILED errorCode=${capture.errorCode ?: "unusable-buffer"}"
                Log.w(TAG, line)
                DebugLogBuffer.add(TAG, line)
                return
            }
            is ScreenCapturer.CaptureResult.Success -> capture.bitmap
        }
        prefs.recordScreenshot()

        // Structural complement to gate 4/4b's keyword matching, scoped to
        // the same browser package list - not a replacement, and
        // deliberately not extended to every app (banking, streaming, and
        // password-manager apps legitimately use the identical mechanism
        // and aren't private browsing). Android renders any FLAG_SECURE
        // window as flat black to every capture path, platform-wide,
        // regardless of what that window's own UI text says - so this
        // catches a private/incognito tab in literally any browser,
        // including ones whose wording IncognitoDetector's keyword lists
        // don't recognize or that aren't a Chromium/Firefox fork at all,
        // without needing to know anything about that browser in advance.
        // Gate 3 already confirmed the accessibility tree sees real
        // image-shaped content here (scan.hasImages) - a captured frame
        // that's uniformly black despite that is the mismatch this exists
        // to catch. Requires both very low brightness AND very low
        // variance, not just "dark," since an ordinary dark-themed page
        // still has real text/icon/border variation that a true
        // FLAG_SECURE cutout doesn't.
        if (IncognitoDetector.isBrowserPackage(pkg)) {
            val secureCheck = SecureContentDetector.analyze(bitmap)
            if (prefs.verboseLogging) {
                val line = "[$pkg] SECURE_CONTENT_CHECK avgLuma=${"%.1f".format(secureCheck.avgLuma)} stdDev=${"%.1f".format(secureCheck.stdDev)}"
                Log.d(TAG, line)
                DebugLogBuffer.add(TAG, line)
            }
            if (secureCheck.looksSecureBlocked) {
                if (!overlay.isVisible()) {
                    val line = "[$pkg] exit@GATE5B_SECURE_CONTENT_DETECTED avgLuma=${"%.1f".format(secureCheck.avgLuma)} stdDev=${"%.1f".format(secureCheck.stdDev)}"
                    Log.i(TAG, line)
                    DebugLogBuffer.add(TAG, line)
                    withContext(Dispatchers.Main) { overlay.show(pkg) }
                }
                bitmap.recycle()
                return
            }
        }

        val skinAnalysis = SkinTonePrefilter.analyze(bitmap)
        if (!skinAnalysis.hasSkin) {
            exitSafe(pkg, "GATE6_NO_SKIN_TONE")
            bitmap.recycle()
            return
        }

        // Refine to wherever skin is actually concentrated, on top of
        // whatever crop (if any) the accessibility tree already gave us -
        // real testing found a photo's surrounding UI chrome (header,
        // username/title, vote/comment buttons, even the next post
        // already peeking in) diluting classifier confidence the same way
        // regardless of app/framework, since the accessibility-based crop
        // can't reliably isolate the photo alone in every case. This
        // works directly off pixels, so it doesn't depend on any
        // particular app exposing precise bounds.
        val analysisBitmap = skinAnalysis.region?.let { cropToRegion(bitmap, it) } ?: bitmap

        try {
            // Inference-optimization gate, inserted after region capture and
            // before the classifier per its own design brief - see
            // FrameDiffGate's class doc for the asymmetric skip logic. Only
            // ever skips by reusing an already-BLOCKED verdict on a frame
            // that still looks the same; a CLEAR verdict never skips, and
            // any failure here (hash exception, bad bitmap) falls through
            // to a real classifier run below.
            val diffOutcome = if (prefs.frameDiffGateEnabled) {
                frameDiffGate.evaluate(
                    pkg = pkg,
                    bitmap = analysisBitmap,
                    hammingThreshold = prefs.frameDiffHammingThreshold,
                    maxSkipCount = prefs.frameDiffMaxSkipCount,
                    maxSkipAgeMs = prefs.frameDiffMaxSkipAgeMs,
                )
            } else {
                null
            }

            if (diffOutcome?.skip == true) {
                if (prefs.verboseLogging) {
                    val line = "[$pkg] FRAME_DIFF_SKIP hamming=${diffOutcome.hammingDistance} verdict=blocked skipCount=${diffOutcome.skipCount}"
                    Log.d(TAG, line)
                    DebugLogBuffer.add(TAG, line)
                }
                handleBlock(pkg, "score=cached(skip)")
                return
            }

            val inferenceStartNanos = System.nanoTime()
            val score = nsfwClassifier.scoreNsfw(analysisBitmap, pkg)
            prefs.recordInference((System.nanoTime() - inferenceStartNanos) / 1_000_000)
            if (prefs.verboseLogging) DebugLogBuffer.add(TAG, "[$pkg] captureMs=$captureMs")

            val blocked = score >= prefs.nsfwThreshold
            // Only a real inference ever updates the cache - a skip must
            // never be recorded as if it were a fresh observation, or a
            // stale hash could compound across cycles.
            if (prefs.frameDiffGateEnabled) {
                frameDiffGate.recordRealResult(pkg, analysisBitmap, blocked)
            }

            if (!blocked) {
                exitSafe(pkg, "GATE7_BELOW_THRESHOLD score=$score")
                return
            }

            handleBlock(pkg, "score=$score")
        } finally {
            if (analysisBitmap !== bitmap) analysisBitmap.recycle()
            bitmap.recycle()
        }
    }

    /**
     * Gate 8: the actual block, plus strike/lockout bookkeeping - shared by
     * both a real classifier verdict and a FrameDiffGate skip that reused a
     * cached BLOCKED verdict, so the two paths can never drift apart on
     * what "blocked" actually does.
     */
    private suspend fun handleBlock(pkg: String, detail: String) {
        val blockLine = "[$pkg] exit@GATE8_BLOCK $detail"
        Log.i(TAG, blockLine)
        DebugLogBuffer.add(TAG, blockLine)
        prefs.recordBlock()
        if (prefs.recordExplicitStrike(pkg)) {
            val lockLine = "[$pkg] LOCKOUT_TRIGGERED durationMin=${prefs.lockoutDurationMinutes}"
            Log.i(TAG, lockLine)
            DebugLogBuffer.add(TAG, lockLine)

            // Stronger than the plain GLOBAL_ACTION_HOME every block
            // already does on dismissal - on the strike that actually
            // trips the lockout, back out of the app immediately
            // (rather than waiting for the user to tap through the
            // fake-crash dialog first) and ask the OS to kill its
            // background process, so switching back via Recents finds
            // a cold start instead of resuming exactly where they left
            // off. killBackgroundProcesses() only needs the normal
            // KILL_BACKGROUND_PROCESSES permission (no root/adb), but
            // it's a hint the OS can decline, not a guaranteed kill
            // the way Settings' own "Force Stop" button is - that API
            // is signature-protected and unavailable to third-party
            // apps even with Shizuku's shell-level access.
            withContext(Dispatchers.Main) { performGlobalAction(GLOBAL_ACTION_HOME) }
            delay(500)
            activityManager.killBackgroundProcesses(pkg)
            val killLine = "[$pkg] KILL_BACKGROUND_PROCESSES requested after lockout"
            Log.i(TAG, killLine)
            DebugLogBuffer.add(TAG, killLine)
        }
        withContext(Dispatchers.Main) { overlay.show(pkg) }
    }

    private fun cropToRegion(bitmap: Bitmap, region: Rect): Bitmap {
        val left = region.left.coerceIn(0, bitmap.width - 1)
        val top = region.top.coerceIn(0, bitmap.height - 1)
        val right = region.right.coerceIn(left + 1, bitmap.width)
        val bottom = region.bottom.coerceIn(top + 1, bitmap.height)
        return try {
            Bitmap.createBitmap(bitmap, left, top, right - left, bottom - top)
        } catch (e: Exception) {
            Log.w(TAG, "cropToRegion failed, using full frame", e)
            bitmap
        }
    }

    /**
     * Backs out of a dismissed block twice, not once, before landing on
     * the home screen. A single back-press often only closes an in-app
     * photo/video viewer without leaving the app itself - which meant
     * Recents' task-switcher thumbnail for that app could still show
     * whatever explicit content was last rendered right before the
     * overlay went up, even though the overlay itself was gone. The delay
     * between each action gives its UI transition a real chance to finish
     * before the next one fires, rather than racing/coalescing them.
     */
    private suspend fun dismissBlockedApp() {
        performGlobalAction(GLOBAL_ACTION_BACK)
        delay(200)
        performGlobalAction(GLOBAL_ACTION_BACK)
        delay(200)
        performGlobalAction(GLOBAL_ACTION_HOME)
    }

    /** Fails open (true) if the window can't be found - matches prior behavior for that case. */
    private fun isApplicationWindow(windowId: Int): Boolean {
        val window = windows.firstOrNull { it.id == windowId } ?: return true
        return window.type == AccessibilityWindowInfo.TYPE_APPLICATION
    }

    private fun unionOf(rects: List<Rect>): Rect? {
        if (rects.isEmpty()) return null
        val union = Rect(rects[0])
        for (i in 1 until rects.size) union.union(rects[i])
        return union
    }

    /**
     * Logs a safe gate exit. Deliberately does NOT hide the overlay here:
     * once shown, a block should only go away via a genuine app switch
     * (handled in onAccessibilityEvent) or the user dismissing the fake
     * crash dialog themselves (BlurOverlayController's onOkTapped/
     * onBackKeyPressed) - not because the cascade re-evaluated whatever
     * the blocked app changed to in the background (autoplay advancing,
     * an ad rotating, infinite scroll loading fresh content) as "safe".
     * That was a real bug: the block could silently vanish with no user
     * action at all.
     *
     * Gated on prefs.verboseLogging: every one of this function's callers
     * is a routine, nothing-to-report exit that fires on most processed
     * frames (GATE_NO_ROOT/GATE3/GATE6/GATE7) - unlike an actual block or
     * detection, there's no rare, meaningful event here to justify paying
     * a DebugLogBuffer write (timestamp formatting + a synchronized deque
     * insert) unconditionally, all the time, whether or not the Debug log
     * is even being watched.
     */
    private fun exitSafe(pkg: String, gate: String) {
        if (!prefs.verboseLogging) return
        val line = "[$pkg] exit@$gate"
        Log.d(TAG, line)
        DebugLogBuffer.add(TAG, line)
    }

    override fun onInterrupt() {
        val line = "onInterrupt"
        Log.w(TAG, line)
        DebugLogBuffer.add(TAG, line)
    }

    /**
     * Must leave the service in a state a later onServiceConnected can fully
     * rebuild from - Android is free to reconnect this same instance after a
     * teardown, and everything torn down here (the cancelled scope, the
     * closed ONNX session) is unusable afterwards. Hence clearing
     * [oneTimeSetupDone] and the receiver handles: whatever this method
     * undoes, initializeOnce has to be allowed to do again, or the cascade
     * stays permanently dead while the service still looks connected.
     *
     * Logged unconditionally, first thing - previously this teardown left no
     * trace anywhere reachable without adb, which is the actual reason "the
     * log isn't logging" for the common case here: HEARTBEAT_STALE proves
     * AccessibilityWatchdogService (same process) stays alive and ticking
     * while this happens, so it's this service's live binding dying, not a
     * process restart - CrashLog/ContentGuardApplication's restart-gap line
     * (which only fires on an actual fresh process) never had a chance to
     * catch it. This line is what actually marks the moment it happens.
     */
    override fun onDestroy() {
        val line = "onDestroy - live setup torn down"
        Log.w(TAG, line)
        DebugLogBuffer.add(TAG, line)
        super.onDestroy()
        if (::overlay.isInitialized && overlay.isVisible()) overlay.hide()
        if (::passwordGuardOverlay.isInitialized && passwordGuardOverlay.isVisible()) passwordGuardOverlay.hide()
        if (::nsfwClassifier.isInitialized) nsfwClassifier.close()
        if (::prefs.isInitialized) prefs.flushUsageStats()
        // Nulled after unregistering, not just unregistered: the registration
        // helpers unregister whatever they find here before re-registering,
        // and passing an already-unregistered receiver back to
        // unregisterReceiver throws IllegalArgumentException.
        packageChangeReceiver?.let { unregisterReceiver(it) }
        packageChangeReceiver = null
        screenStateReceiver?.let { unregisterReceiver(it) }
        screenStateReceiver = null
        registryRefreshJob = null
        serviceScope.cancel()
        oneTimeSetupDone = false
    }

    companion object {
        private const val TAG = "ContentGuardService"

        // SupervisorJob so a failure in one detection loop can never cancel
        // the other (or the scope itself). A fresh one is built per
        // initializeOnce - see the serviceScope field's comment.
        private fun newServiceScope(): CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

        // Pause after a failed static-recheck tick before going round again -
        // see the catch block in recheckStaticContent. Deliberately a
        // constant rather than the tunable interval, so the recovery path
        // can't fault on the same state the tick just faulted on.
        private const val RECHECK_ERROR_BACKOFF_MS = 5_000L

        // See consumeFrames' doc comment. Well above any real frame - the
        // capture timeout alone (ScreenCapturer.SCREENSHOT_CALLBACK_TIMEOUT_MS,
        // 10s) already accounts for the slowest single suspend point in the
        // cascade, so this only needs enough headroom on top of that for the
        // tree walk plus classifier inference to genuinely finish, not to
        // itself become a tight bound.
        private const val PROCESS_FRAME_TIMEOUT_MS = 20_000L

        // Standard AOSP Settings package - the "Device admin apps" and
        // "Accessibility" screens are core fragments OEMs rarely
        // reimplement (unlike the heavily-customized battery/app-info
        // screens elsewhere in ColorOS), so this should hold even though
        // other Settings screens don't.
        private const val SETTINGS_PACKAGE = "com.android.settings"

        // Matched against the window's own title, not screen content - see
        // the comment at the call site. "contentguard" covers the standard
        // AOSP "App info" screen (Settings > Apps > ContentGuard), whose
        // title really is the app's own display label - unlike ColorOS's
        // separate per-app battery page, which needed a different fix
        // entirely (see OPLUS_BATTERY_PACKAGE below).
        //
        // Deliberately no "accessibility" marker: confirmed via direct
        // real-device testing that AccessibilityWatchdogService restores
        // ContentGuardService's own entry in enabled_accessibility_services
        // (and anything opted into SecurityTab's "Also persist") the moment
        // it's found missing, so gating the Accessibility screen itself
        // blocked nothing real - only added friction reaching a screen the
        // watchdog immediately undoes anyway. Device admin has no such
        // self-healing counterpart, which is exactly why it still needs
        // this gate.
        private val GUARDED_SETTINGS_TITLE_MARKERS = listOf("device admin", "contentguard")

        // One refresh per install batch instead of one per package - see
        // registerPackageChangeReceiver. Long enough to straddle the gaps
        // between a Play auto-update batch's per-package broadcasts, short
        // enough that a just-installed browser is recognized within seconds.
        private const val REGISTRY_REFRESH_DEBOUNCE_MS = 5_000L

        // Discovered via real-device logging (GATE_SETTINGS_GUARD_DEBUG,
        // since removed) that ColorOS's per-app battery-management page
        // (Settings > Battery > ContentGuard - the screen with its own
        // "Force stop" button Device Admin's protection doesn't reach) is
        // hosted in this entirely separate package, never SETTINGS_PACKAGE -
        // the original "contentguard" title marker could never have
        // matched here regardless of wording, since the check never even
        // ran against this package. Its title is also just the generic
        // "Battery", shared by every app's battery page - so unlike
        // SETTINGS_PACKAGE this can't be told apart by title at all; see
        // the content-based check at the call site instead.
        private const val OPLUS_BATTERY_PACKAGE = "com.oplus.battery"

        // See heartbeatLoop and PrefsRepository.lastHeartbeatAtMillis. Cheap
        // enough at this cadence to run indefinitely regardless of screen
        // state; frequent enough that AccessibilityWatchdogService's own
        // staleness threshold (HEARTBEAT_STALE_THRESHOLD_MS there, a
        // multiple of this) can tell "dead" apart from "just hasn't ticked
        // yet" within a reasonable window.
        const val HEARTBEAT_INTERVAL_MS = 5 * 60_000L
    }
}
