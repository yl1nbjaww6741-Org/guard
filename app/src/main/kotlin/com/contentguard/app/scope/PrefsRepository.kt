package com.contentguard.app.scope

import android.content.Context
import android.content.SharedPreferences
import com.contentguard.app.detect.KeywordBlocklist
import java.security.MessageDigest

/**
 * SharedPreferences on purpose, not DataStore: after the first (async,
 * one-time) XML parse, every read is a synchronous in-memory map lookup,
 * which is what we need on the accessibility-event hot path. DataStore's
 * Flow-based API would force us to cache values ourselves anyway.
 */
class PrefsRepository(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var mode: ScopeMode
        get() {
            val raw = prefs.getString(KEY_MODE, null) ?: return ScopeMode.MONITOR_ALL_EXCEPT_WHITELIST
            return runCatching { ScopeMode.valueOf(raw) }.getOrDefault(ScopeMode.MONITOR_ALL_EXCEPT_WHITELIST)
        }
        set(value) {
            prefs.edit().putString(KEY_MODE, value.name).apply()
        }

    var nsfwThreshold: Float
        get() = prefs.getFloat(KEY_THRESHOLD, DEFAULT_THRESHOLD)
        set(value) {
            prefs.edit().putFloat(KEY_THRESHOLD, value.coerceIn(0f, 1f)).apply()
        }

    var dismissOnBlock: Boolean
        get() = prefs.getBoolean(KEY_DISMISS_ON_BLOCK, false)
        set(value) {
            prefs.edit().putBoolean(KEY_DISMISS_ON_BLOCK, value).apply()
        }

    /**
     * Minimum time between screenshots while a monitored app is open -
     * previously ScreenCapturer's own hardcoded THROTTLE_FLOOR_MS, now
     * user-tunable from Settings since it's a real latency-vs-battery trade
     * (see SETUP.md's "Tuned for detection speed over battery" / "Doubled
     * back up for battery" history) rather than a one-size-fits-all value.
     */
    var captureThrottleMs: Long
        get() = prefs.getLong(KEY_CAPTURE_THROTTLE_MS, DEFAULT_CAPTURE_THROTTLE_MS)
        set(value) {
            prefs.edit().putLong(KEY_CAPTURE_THROTTLE_MS, value.coerceIn(MIN_CAPTURE_THROTTLE_MS, MAX_CAPTURE_THROTTLE_MS)).apply()
        }

    /**
     * Kept in lockstep with [captureThrottleMs] rather than independently
     * configurable - it only ever needs to stay a little above the capture
     * throttle floor (see ContentGuardService.recheckStaticContent's doc
     * comment), or the periodic backstop would just spend ticks getting
     * throttled away for no benefit. A second slider for this specifically
     * would let the user create that exact bad configuration for no gain.
     */
    val staticRecheckIntervalMs: Long
        get() = captureThrottleMs + STATIC_RECHECK_MARGIN_MS

    /**
     * FrameDiffGate's own on/off switch - off by default, preserving
     * today's "gate 7 always runs" behavior until explicitly opted into.
     * See FrameDiffGate's class doc for the asymmetric skip design.
     */
    var frameDiffGateEnabled: Boolean
        get() = prefs.getBoolean(KEY_FRAME_DIFF_ENABLED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_FRAME_DIFF_ENABLED, value).apply()
        }

    /** Max dHash Hamming distance (0-64 bits) for two frames to count as "the same picture." */
    var frameDiffHammingThreshold: Int
        get() = prefs.getInt(KEY_FRAME_DIFF_HAMMING, DEFAULT_FRAME_DIFF_HAMMING)
        set(value) {
            prefs.edit().putInt(KEY_FRAME_DIFF_HAMMING, value.coerceIn(0, 64)).apply()
        }

    /** Forced-refresh ceiling (count side): a cached BLOCKED verdict can only ride this many consecutive skips before a real inference runs again regardless of similarity. */
    var frameDiffMaxSkipCount: Int
        get() = prefs.getInt(KEY_FRAME_DIFF_MAX_SKIP_COUNT, DEFAULT_FRAME_DIFF_MAX_SKIP_COUNT)
        set(value) {
            prefs.edit().putInt(KEY_FRAME_DIFF_MAX_SKIP_COUNT, value.coerceIn(1, 100)).apply()
        }

    /** Forced-refresh ceiling (time side): ...or this many milliseconds since the last real inference, whichever comes first. */
    var frameDiffMaxSkipAgeMs: Long
        get() = prefs.getLong(KEY_FRAME_DIFF_MAX_SKIP_AGE_MS, DEFAULT_FRAME_DIFF_MAX_SKIP_AGE_MS)
        set(value) {
            prefs.edit().putLong(KEY_FRAME_DIFF_MAX_SKIP_AGE_MS, value.coerceIn(1000L, 120_000L)).apply()
        }

    fun getWhitelist(): Set<String> = prefs.getStringSet(KEY_WHITELIST, null)?.toSet() ?: emptySet()

    fun setWhitelisted(packageName: String, whitelisted: Boolean) {
        val next = getWhitelist().toMutableSet()
        if (whitelisted) next.add(packageName) else next.remove(packageName)
        prefs.edit().putStringSet(KEY_WHITELIST, next).apply()
    }

    /** Same as [setWhitelisted] but one prefs write for the whole batch - the Apps tab's per-category bulk on/off. */
    fun setWhitelistedBulk(packageNames: Collection<String>, whitelisted: Boolean) {
        val next = getWhitelist().toMutableSet()
        if (whitelisted) next.addAll(packageNames) else next.removeAll(packageNames.toSet())
        prefs.edit().putStringSet(KEY_WHITELIST, next).apply()
    }

    fun getMonitoredSet(): Set<String> = prefs.getStringSet(KEY_MONITORED, null)?.toSet() ?: emptySet()

    fun setMonitored(packageName: String, monitored: Boolean) {
        val next = getMonitoredSet().toMutableSet()
        if (monitored) next.add(packageName) else next.remove(packageName)
        prefs.edit().putStringSet(KEY_MONITORED, next).apply()
    }

    /** Same as [setMonitored] but one prefs write for the whole batch - the Apps tab's per-category bulk on/off. */
    fun setMonitoredBulk(packageNames: Collection<String>, monitored: Boolean) {
        val next = getMonitoredSet().toMutableSet()
        if (monitored) next.addAll(packageNames) else next.removeAll(packageNames.toSet())
        prefs.edit().putStringSet(KEY_MONITORED, next).apply()
    }

    /**
     * Gate 4b's active keyword set - starts from [KeywordBlocklist.EXPLICIT_KEYWORDS]
     * (the built-in default) until the user customizes it via Settings, at
     * which point the stored set becomes authoritative rather than layered
     * on top of the default. Editable the same way threshold/lockout/
     * whitelist already are - password-gated Settings, not a dedicated
     * on/off switch (see IncognitoDetector/KeywordBlocklist doc comments
     * for why this feature itself has no such switch).
     */
    fun getExplicitKeywords(): Set<String> =
        prefs.getStringSet(KEY_EXPLICIT_KEYWORDS, null)?.toSet() ?: KeywordBlocklist.EXPLICIT_KEYWORDS

    fun setExplicitKeywords(keywords: Set<String>) {
        val normalized = keywords.map { it.trim().lowercase() }.filter { it.isNotBlank() }.toSet()
        prefs.edit().putStringSet(KEY_EXPLICIT_KEYWORDS, normalized).apply()
    }

    fun addExplicitKeyword(keyword: String) {
        setExplicitKeywords(getExplicitKeywords() + keyword)
    }

    fun removeExplicitKeyword(keyword: String) {
        setExplicitKeywords(getExplicitKeywords() - keyword)
    }

    /** Reverts to the built-in default list by clearing the stored override entirely. */
    fun resetExplicitKeywordsToDefault() {
        prefs.edit().remove(KEY_EXPLICIT_KEYWORDS).apply()
    }

    fun explicitKeywordsAreCustomized(): Boolean = prefs.contains(KEY_EXPLICIT_KEYWORDS)

    /**
     * Not real battery-percentage accounting - Android doesn't expose that
     * to third-party apps, only the OS's own battery stats (Settings >
     * Battery, or `adb shell dumpsys batterystats`) have that. This is a
     * proxy: counts of the two operations that actually cost real battery
     * (screenshot capture, classifier inference), so relative load is
     * visible without pretending to be a number this app can't actually
     * measure. See SettingsActivity's "Activity since last reset" card.
     */
    data class UsageStats(
        val screenshotCount: Int,
        val inferenceCount: Int,
        val totalInferenceMs: Long,
        val blockCount: Int,
        val sinceMillis: Long,
    ) {
        val avgInferenceMs: Double get() = if (inferenceCount == 0) 0.0 else totalInferenceMs.toDouble() / inferenceCount
    }

    /**
     * Off by default: routine gate-exit logging (GATE1/GATE2/GATE5/GATE6/
     * GATE7/GATE_NO_ROOT/GATE3 - the ones that fire on nearly every frame
     * with nothing to report) costs a DebugLogBuffer write - timestamp
     * formatting plus a synchronized deque insert - every single time,
     * regardless of whether anyone's watching the Debug log. Meaningful
     * events (blocks, incognito/keyword detection, lockouts, the Settings
     * guard) always log regardless of this flag, since those are rare and
     * worth keeping visible unconditionally. Turn this on only while
     * actively diagnosing something - same Debug log card in the Activity
     * tab, just opt-in for the noisy part.
     */
    var verboseLogging: Boolean
        get() = prefs.getBoolean(KEY_VERBOSE_LOGGING, false)
        set(value) {
            prefs.edit().putBoolean(KEY_VERBOSE_LOGGING, value).apply()
        }

    fun getUsageStats(): UsageStats = UsageStats(
        screenshotCount = prefs.getInt(KEY_SCREENSHOT_COUNT, 0),
        inferenceCount = prefs.getInt(KEY_INFERENCE_COUNT, 0),
        totalInferenceMs = prefs.getLong(KEY_TOTAL_INFERENCE_MS, 0L),
        blockCount = prefs.getInt(KEY_BLOCK_COUNT, 0),
        sinceMillis = prefs.getLong(KEY_STATS_SINCE, 0L),
    )

    fun recordScreenshot() {
        prefs.edit().putInt(KEY_SCREENSHOT_COUNT, prefs.getInt(KEY_SCREENSHOT_COUNT, 0) + 1).apply()
    }

    fun recordInference(latencyMs: Long) {
        prefs.edit()
            .putInt(KEY_INFERENCE_COUNT, prefs.getInt(KEY_INFERENCE_COUNT, 0) + 1)
            .putLong(KEY_TOTAL_INFERENCE_MS, prefs.getLong(KEY_TOTAL_INFERENCE_MS, 0L) + latencyMs)
            .apply()
    }

    fun recordBlock() {
        prefs.edit().putInt(KEY_BLOCK_COUNT, prefs.getInt(KEY_BLOCK_COUNT, 0) + 1).apply()
    }

    fun resetUsageStats() {
        prefs.edit()
            .putInt(KEY_SCREENSHOT_COUNT, 0)
            .putInt(KEY_INFERENCE_COUNT, 0)
            .putLong(KEY_TOTAL_INFERENCE_MS, 0L)
            .putInt(KEY_BLOCK_COUNT, 0)
            .putLong(KEY_STATS_SINCE, System.currentTimeMillis())
            .apply()
    }

    var lockoutDurationMinutes: Int
        get() = prefs.getInt(KEY_LOCKOUT_DURATION_MIN, DEFAULT_LOCKOUT_MINUTES)
        set(value) {
            prefs.edit().putInt(KEY_LOCKOUT_DURATION_MIN, value.coerceIn(1, 60)).apply()
        }

    // Adjustable so testing doesn't keep tripping a real lockout after a
    // couple of blocks - raise it for a longer test session, not a
    // permanent behavior change.
    var strikesToLockout: Int
        get() = prefs.getInt(KEY_STRIKES_TO_LOCKOUT, DEFAULT_STRIKES_TO_LOCKOUT)
        set(value) {
            prefs.edit().putInt(KEY_STRIKES_TO_LOCKOUT, value.coerceIn(1, 20)).apply()
        }

    /**
     * Records an explicit-content detection for [packageName] and, once
     * [strikesToLockout] such strikes land within a rolling 15-minute
     * window, locks that single app out for [lockoutDurationMinutes].
     * Returns true exactly when this call was the one that triggered the
     * lockout, so the caller can log it distinctly from an ordinary strike.
     */
    fun recordExplicitStrike(packageName: String): Boolean {
        val now = System.currentTimeMillis()
        val key = strikeKey(packageName)
        val recentStrikes = (prefs.getStringSet(key, null) ?: emptySet())
            .mapNotNull { it.toLongOrNull() }
            .filter { now - it < STRIKE_WINDOW_MS }
            .toMutableList()
        recentStrikes.add(now)

        if (recentStrikes.size >= strikesToLockout) {
            prefs.edit()
                .remove(key)
                .putLong(lockoutKey(packageName), now + lockoutDurationMinutes * 60_000L)
                .apply()
            return true
        }
        prefs.edit().putStringSet(key, recentStrikes.map { it.toString() }.toSet()).apply()
        return false
    }

    fun isLockedOut(packageName: String): Boolean = getLockoutUntil(packageName) > System.currentTimeMillis()

    fun getLockoutUntil(packageName: String): Long = prefs.getLong(lockoutKey(packageName), 0L)

    /** Package name -> lockout-expiry millis, for currently locked-out apps only. Debug/Settings display use. */
    fun getActiveLockouts(): Map<String, Long> {
        val now = System.currentTimeMillis()
        return prefs.all
            .mapNotNull { (key, value) ->
                if (!key.startsWith(KEY_LOCKOUT_PREFIX) || value !is Long) return@mapNotNull null
                if (value <= now) return@mapNotNull null
                key.removePrefix(KEY_LOCKOUT_PREFIX) to value
            }
            .toMap()
    }

    private fun strikeKey(packageName: String) = "$KEY_STRIKES_PREFIX$packageName"
    private fun lockoutKey(packageName: String) = "$KEY_LOCKOUT_PREFIX$packageName"

    /**
     * Gates ContentGuard's own Settings screen and (see ContentGuardService)
     * the system "Device admin apps" screen - without the latter, deactivating
     * device admin would undo the force-stop/uninstall protection with zero
     * friction. Stored as a salted SHA-256 hash, never the raw password.
     */
    fun hasPassword(): Boolean = prefs.contains(KEY_PASSWORD_HASH)

    fun setPassword(raw: String) {
        prefs.edit().putString(KEY_PASSWORD_HASH, hash(raw)).apply()
    }

    fun verifyPassword(raw: String): Boolean {
        val stored = prefs.getString(KEY_PASSWORD_HASH, null) ?: return false
        return stored == hash(raw)
    }

    private fun hash(raw: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest((PASSWORD_SALT + raw).toByteArray())
        return bytes.joinToString("") { "%02x".format(it) }
    }

    /**
     * Anti-impulse cooldown: when on, a correct password doesn't weaken
     * protection immediately - see [PendingWeakenAction] and
     * [applyPendingWeakenActionIfEligible]. Off by default, preserving
     * today's instant-apply-on-correct-password behavior exactly.
     */
    var delayBeforeUnlockEnabled: Boolean
        get() = prefs.getBoolean(KEY_DELAY_BEFORE_UNLOCK_ENABLED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_DELAY_BEFORE_UNLOCK_ENABLED, value).apply()
        }

    /** One of the preset delay options (minutes) - see SecurityTab's picker. */
    var delayBeforeUnlockMinutes: Int
        get() = prefs.getInt(KEY_DELAY_BEFORE_UNLOCK_MINUTES, DEFAULT_DELAY_BEFORE_UNLOCK_MINUTES)
        set(value) {
            prefs.edit().putInt(KEY_DELAY_BEFORE_UNLOCK_MINUTES, value).apply()
        }

    /**
     * Anti-impulse cooldown for the OS-level guarded screens - Accessibility
     * settings, Device admin apps, and the ColorOS per-app battery page
     * with its own Force-stop button (see ContentGuardService's
     * GATE_SETTINGS_GUARD). Deliberately separate from [PendingWeakenAction]:
     * there's no in-app setting to defer here, since the actual weakening
     * (deactivating accessibility/admin, tapping Force stop) happens
     * entirely on that external OS screen, outside this app's control, the
     * moment it becomes reachable. So this defers *reaching the screen*
     * itself - a correct password starts the cooldown; ContentGuardService
     * only actually grants access once it elapses. 0 means no cooldown is
     * running. Persisted (not just an in-memory flag) specifically because
     * force-stopping the app or rebooting must not let someone skip the
     * wait by restarting the process partway through it.
     */
    var settingsGuardCooldownEligibleAtMillis: Long
        get() = prefs.getLong(KEY_SETTINGS_GUARD_COOLDOWN_ELIGIBLE_AT, 0L)
        set(value) {
            prefs.edit().putLong(KEY_SETTINGS_GUARD_COOLDOWN_ELIGIBLE_AT, value).apply()
        }

    fun clearSettingsGuardCooldown() {
        prefs.edit().remove(KEY_SETTINGS_GUARD_COOLDOWN_ELIGIBLE_AT).apply()
    }

    /**
     * A weakening action whose password challenge has already been passed,
     * but which [delayBeforeUnlockEnabled] defers rather than applying
     * immediately. Deliberately a small, serializable descriptor - not the
     * raw Compose closure the UI call site actually built (see
     * ContentGuardApp.applyOrChallenge) - because this has to survive app
     * restart, force-stop, and reboot: a closure can't be written to
     * SharedPreferences and reconstructed by a cold process, but "which
     * setting, what value" can.
     *
     * [SetPasswordHash] stores the new password's hash, never the raw
     * password - computed once at challenge time via [hashPasswordForPending],
     * so no plaintext secret ever sits in persisted state even transiently.
     *
     * Deliberately excludes the two OS-navigation gates (opening the
     * accessibility/device-admin settings screens, gated via
     * CGGatedButton) - those launch an external screen rather than change
     * any of ContentGuard's own state, so there's nothing here to defer or
     * persist; they stay instant-on-password as before.
     */
    sealed class PendingWeakenAction {
        data class SetThreshold(val value: Float) : PendingWeakenAction()
        data class SetCaptureThrottleMs(val value: Long) : PendingWeakenAction()
        data class RemoveKeyword(val keyword: String) : PendingWeakenAction()
        object ResetKeywordsToDefault : PendingWeakenAction()
        data class SetStrikesToLockout(val value: Int) : PendingWeakenAction()
        data class SetLockoutDurationMinutes(val value: Int) : PendingWeakenAction()
        data class SetWhitelisted(val packageName: String, val whitelisted: Boolean) : PendingWeakenAction()
        data class SetMonitored(val packageName: String, val monitored: Boolean) : PendingWeakenAction()

        // Apps tab's per-category "Allow all" bulk action - one password
        // challenge for the whole batch rather than one per app (which
        // would mean re-entering the password dozens of times for a
        // system-apps category). packageNames is whatever was visible in
        // that section at tap time (current search/filter included), not
        // necessarily every app in the category.
        data class SetWhitelistedBulk(val packageNames: List<String>, val whitelisted: Boolean) : PendingWeakenAction()
        data class SetMonitoredBulk(val packageNames: List<String>, val monitored: Boolean) : PendingWeakenAction()
        data class SetScopeMode(val mode: ScopeMode) : PendingWeakenAction()
        data class SetPasswordHash(val hash: String) : PendingWeakenAction()

        // These two exist so the cooldown can't be trivially bypassed by
        // just turning itself off first: disabling delay-before-unlock, or
        // shortening its delay, is itself the weakening move for this
        // feature (see SecurityTab's toggle/picker) and goes through the
        // exact same password + deferral path as everything else it
        // protects. Enabling it, or lengthening the delay, stays free/
        // instant, same asymmetry as every other setting in this file.
        data class SetDelayBeforeUnlockEnabled(val enabled: Boolean) : PendingWeakenAction()
        data class SetDelayBeforeUnlockMinutes(val minutes: Int) : PendingWeakenAction()
    }

    /** A pending unlock as actually persisted: the action plus when it becomes eligible. */
    data class PendingUnlock(val action: PendingWeakenAction, val eligibleAtMillis: Long)

    /** Precomputes a password's hash for [PendingWeakenAction.SetPasswordHash] - the same hash [setPassword] would store, just without writing it yet. */
    fun hashPasswordForPending(raw: String): String = hash(raw)

    /**
     * Persists [action] as the one pending unlock, replacing any existing
     * one - only a single slot is kept (see class doc on
     * [PendingWeakenAction]): a new weakening request made while one is
     * already pending overwrites it with a fresh eligible-at, rather than
     * queuing both.
     */
    fun setPendingWeakenAction(action: PendingWeakenAction, eligibleAtMillis: Long) {
        prefs.edit()
            .putString(KEY_PENDING_ACTION_TYPE, action.typeTag())
            .putString(KEY_PENDING_ACTION_PARAM, action.paramValue())
            .putLong(KEY_PENDING_ELIGIBLE_AT, eligibleAtMillis)
            .apply()
    }

    fun getPendingUnlock(): PendingUnlock? {
        val type = prefs.getString(KEY_PENDING_ACTION_TYPE, null) ?: return null
        val param = prefs.getString(KEY_PENDING_ACTION_PARAM, "").orEmpty()
        val eligibleAt = prefs.getLong(KEY_PENDING_ELIGIBLE_AT, 0L)
        val action = decodePendingAction(type, param) ?: return null
        return PendingUnlock(action, eligibleAt)
    }

    /** Discards a pending unlock outright - the safe direction, always allowed with no challenge. */
    fun clearPendingWeakenAction() {
        prefs.edit()
            .remove(KEY_PENDING_ACTION_TYPE)
            .remove(KEY_PENDING_ACTION_PARAM)
            .remove(KEY_PENDING_ELIGIBLE_AT)
            .apply()
    }

    /**
     * Applies the pending action for real if [PendingUnlock.eligibleAtMillis]
     * has passed, then clears it. No-ops (returns null) if there's nothing
     * pending or it isn't eligible yet. Called from ContentGuardService on
     * service (re)connect and its periodic recheck loop - both already
     * running whenever the app is alive at all, so this needs no new
     * background infrastructure (no AlarmManager/WorkManager), and
     * re-evaluates correctly after restart, force-stop, or reboot purely
     * because it's driven off this persisted state, not an in-memory timer.
     */
    fun applyPendingWeakenActionIfEligible(): PendingWeakenAction? {
        val pending = getPendingUnlock() ?: return null
        if (System.currentTimeMillis() < pending.eligibleAtMillis) return null
        when (val action = pending.action) {
            is PendingWeakenAction.SetThreshold -> nsfwThreshold = action.value
            is PendingWeakenAction.SetCaptureThrottleMs -> captureThrottleMs = action.value
            is PendingWeakenAction.RemoveKeyword -> removeExplicitKeyword(action.keyword)
            is PendingWeakenAction.ResetKeywordsToDefault -> resetExplicitKeywordsToDefault()
            is PendingWeakenAction.SetStrikesToLockout -> strikesToLockout = action.value
            is PendingWeakenAction.SetLockoutDurationMinutes -> lockoutDurationMinutes = action.value
            is PendingWeakenAction.SetWhitelisted -> setWhitelisted(action.packageName, action.whitelisted)
            is PendingWeakenAction.SetMonitored -> setMonitored(action.packageName, action.monitored)
            is PendingWeakenAction.SetWhitelistedBulk -> setWhitelistedBulk(action.packageNames, action.whitelisted)
            is PendingWeakenAction.SetMonitoredBulk -> setMonitoredBulk(action.packageNames, action.monitored)
            is PendingWeakenAction.SetScopeMode -> mode = action.mode
            is PendingWeakenAction.SetPasswordHash -> prefs.edit().putString(KEY_PASSWORD_HASH, action.hash).apply()
            is PendingWeakenAction.SetDelayBeforeUnlockEnabled -> delayBeforeUnlockEnabled = action.enabled
            is PendingWeakenAction.SetDelayBeforeUnlockMinutes -> delayBeforeUnlockMinutes = action.minutes
        }
        clearPendingWeakenAction()
        return pending.action
    }

    private fun PendingWeakenAction.typeTag(): String = when (this) {
        is PendingWeakenAction.SetThreshold -> "SetThreshold"
        is PendingWeakenAction.SetCaptureThrottleMs -> "SetCaptureThrottleMs"
        is PendingWeakenAction.RemoveKeyword -> "RemoveKeyword"
        PendingWeakenAction.ResetKeywordsToDefault -> "ResetKeywordsToDefault"
        is PendingWeakenAction.SetStrikesToLockout -> "SetStrikesToLockout"
        is PendingWeakenAction.SetLockoutDurationMinutes -> "SetLockoutDurationMinutes"
        is PendingWeakenAction.SetWhitelisted -> "SetWhitelisted"
        is PendingWeakenAction.SetMonitored -> "SetMonitored"
        is PendingWeakenAction.SetWhitelistedBulk -> "SetWhitelistedBulk"
        is PendingWeakenAction.SetMonitoredBulk -> "SetMonitoredBulk"
        is PendingWeakenAction.SetScopeMode -> "SetScopeMode"
        is PendingWeakenAction.SetPasswordHash -> "SetPasswordHash"
        is PendingWeakenAction.SetDelayBeforeUnlockEnabled -> "SetDelayBeforeUnlockEnabled"
        is PendingWeakenAction.SetDelayBeforeUnlockMinutes -> "SetDelayBeforeUnlockMinutes"
    }

    // Encodes each action's params as a single delimited string - deliberately
    // not JSON/a serialization library: one row, few fields, no nesting, and
    // this file already has no such dependency (PrefsRepository is plain
    // SharedPreferences throughout).
    private fun PendingWeakenAction.paramValue(): String = when (this) {
        is PendingWeakenAction.SetThreshold -> value.toString()
        is PendingWeakenAction.SetCaptureThrottleMs -> value.toString()
        is PendingWeakenAction.RemoveKeyword -> keyword
        PendingWeakenAction.ResetKeywordsToDefault -> ""
        is PendingWeakenAction.SetStrikesToLockout -> value.toString()
        is PendingWeakenAction.SetLockoutDurationMinutes -> value.toString()
        is PendingWeakenAction.SetWhitelisted -> "$packageName|$whitelisted"
        is PendingWeakenAction.SetMonitored -> "$packageName|$monitored"
        // Package names never contain "," or "|" (valid Android package
        // name characters are limited to letters, digits, '.', '_'), so a
        // comma-joined list followed by the flag is safe with no escaping.
        is PendingWeakenAction.SetWhitelistedBulk -> "${packageNames.joinToString(",")}|$whitelisted"
        is PendingWeakenAction.SetMonitoredBulk -> "${packageNames.joinToString(",")}|$monitored"
        is PendingWeakenAction.SetScopeMode -> mode.name
        is PendingWeakenAction.SetPasswordHash -> hash
        is PendingWeakenAction.SetDelayBeforeUnlockEnabled -> enabled.toString()
        is PendingWeakenAction.SetDelayBeforeUnlockMinutes -> minutes.toString()
    }

    private fun decodePendingAction(type: String, param: String): PendingWeakenAction? = runCatching {
        when (type) {
            "SetThreshold" -> PendingWeakenAction.SetThreshold(param.toFloat())
            "SetCaptureThrottleMs" -> PendingWeakenAction.SetCaptureThrottleMs(param.toLong())
            "RemoveKeyword" -> PendingWeakenAction.RemoveKeyword(param)
            "ResetKeywordsToDefault" -> PendingWeakenAction.ResetKeywordsToDefault
            "SetStrikesToLockout" -> PendingWeakenAction.SetStrikesToLockout(param.toInt())
            "SetLockoutDurationMinutes" -> PendingWeakenAction.SetLockoutDurationMinutes(param.toInt())
            "SetWhitelisted" -> {
                val (pkg, flag) = param.split("|", limit = 2)
                PendingWeakenAction.SetWhitelisted(pkg, flag.toBoolean())
            }
            "SetMonitored" -> {
                val (pkg, flag) = param.split("|", limit = 2)
                PendingWeakenAction.SetMonitored(pkg, flag.toBoolean())
            }
            "SetWhitelistedBulk" -> {
                val (pkgs, flag) = param.split("|", limit = 2)
                PendingWeakenAction.SetWhitelistedBulk(pkgs.split(",").filter { it.isNotBlank() }, flag.toBoolean())
            }
            "SetMonitoredBulk" -> {
                val (pkgs, flag) = param.split("|", limit = 2)
                PendingWeakenAction.SetMonitoredBulk(pkgs.split(",").filter { it.isNotBlank() }, flag.toBoolean())
            }
            "SetScopeMode" -> PendingWeakenAction.SetScopeMode(ScopeMode.valueOf(param))
            "SetPasswordHash" -> PendingWeakenAction.SetPasswordHash(param)
            "SetDelayBeforeUnlockEnabled" -> PendingWeakenAction.SetDelayBeforeUnlockEnabled(param.toBoolean())
            "SetDelayBeforeUnlockMinutes" -> PendingWeakenAction.SetDelayBeforeUnlockMinutes(param.toInt())
            else -> null
        }
    }.getOrNull()

    companion object {
        private const val PREFS_NAME = "content_guard_prefs"
        private const val KEY_MODE = "scope_mode"
        private const val KEY_WHITELIST = "whitelist_packages"
        private const val KEY_EXPLICIT_KEYWORDS = "explicit_keywords"
        private const val KEY_MONITORED = "monitored_packages"
        private const val KEY_THRESHOLD = "nsfw_threshold"
        private const val KEY_DISMISS_ON_BLOCK = "dismiss_on_block"
        private const val KEY_SCREENSHOT_COUNT = "stats_screenshot_count"
        private const val KEY_INFERENCE_COUNT = "stats_inference_count"
        private const val KEY_TOTAL_INFERENCE_MS = "stats_total_inference_ms"
        private const val KEY_BLOCK_COUNT = "stats_block_count"
        private const val KEY_STATS_SINCE = "stats_since_millis"
        private const val KEY_LOCKOUT_DURATION_MIN = "lockout_duration_min"
        private const val KEY_STRIKES_TO_LOCKOUT = "strikes_to_lockout"
        private const val KEY_STRIKES_PREFIX = "strike_times_"
        private const val KEY_LOCKOUT_PREFIX = "lockout_until_"
        private const val KEY_PASSWORD_HASH = "password_hash"
        private const val KEY_CAPTURE_THROTTLE_MS = "capture_throttle_ms"
        private const val KEY_VERBOSE_LOGGING = "verbose_logging"
        private const val KEY_FRAME_DIFF_ENABLED = "frame_diff_gate_enabled"
        private const val KEY_FRAME_DIFF_HAMMING = "frame_diff_hamming_threshold"
        private const val KEY_FRAME_DIFF_MAX_SKIP_COUNT = "frame_diff_max_skip_count"
        private const val KEY_FRAME_DIFF_MAX_SKIP_AGE_MS = "frame_diff_max_skip_age_ms"
        private const val KEY_DELAY_BEFORE_UNLOCK_ENABLED = "delay_before_unlock_enabled"
        private const val KEY_DELAY_BEFORE_UNLOCK_MINUTES = "delay_before_unlock_minutes"
        private const val KEY_PENDING_ACTION_TYPE = "pending_weaken_action_type"
        private const val KEY_PENDING_ACTION_PARAM = "pending_weaken_action_param"
        private const val KEY_PENDING_ELIGIBLE_AT = "pending_weaken_eligible_at"
        private const val KEY_SETTINGS_GUARD_COOLDOWN_ELIGIBLE_AT = "settings_guard_cooldown_eligible_at"
        private const val PASSWORD_SALT = "contentguard-v1-"
        const val DEFAULT_THRESHOLD = 0.80f
        const val DEFAULT_LOCKOUT_MINUTES = 1
        const val DEFAULT_STRIKES_TO_LOCKOUT = 3
        private const val STRIKE_WINDOW_MS = 15 * 60 * 1000L

        // 1800ms default matches ScreenCapturer's old hardcoded value - see
        // SETUP.md's capture-cadence history for how that number was
        // reached. Floor of 900ms because going lower buys nothing: that's
        // roughly the platform's own takeScreenshot() rate limit
        // (ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT), so the OS starts
        // rejecting calls before a lower slider value would even matter.
        const val DEFAULT_CAPTURE_THROTTLE_MS = 1800L
        const val MIN_CAPTURE_THROTTLE_MS = 900L
        const val MAX_CAPTURE_THROTTLE_MS = 5000L

        // Not private - SettingsActivity's capture-cadence card references
        // this directly so its description text can't drift from the
        // actual margin staticRecheckIntervalMs applies.
        const val STATIC_RECHECK_MARGIN_MS = 200L

        // FrameDiffGate defaults - see FrameDiffGate's own class doc for
        // why these three specifically (similarity threshold, and the two
        // forced-refresh ceilings).
        const val DEFAULT_FRAME_DIFF_HAMMING = 5
        const val DEFAULT_FRAME_DIFF_MAX_SKIP_COUNT = 8
        const val DEFAULT_FRAME_DIFF_MAX_SKIP_AGE_MS = 20_000L

        // Presets shown in SecurityTab's delay picker (minutes) - not user's
        // own custom value, deliberately: a fixed set of sensible cooldowns
        // rather than a free-typed number, so this can't be set to
        // something with no meaningful cooldown value.
        val DELAY_BEFORE_UNLOCK_PRESETS_MINUTES = listOf(1, 5, 15, 30, 60, 240, 720, 1440)
        const val DEFAULT_DELAY_BEFORE_UNLOCK_MINUTES = 5
    }
}
