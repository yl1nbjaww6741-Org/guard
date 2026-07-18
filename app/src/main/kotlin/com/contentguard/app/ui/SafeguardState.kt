package com.contentguard.app.ui

/**
 * The three live runtime checks behind the Home seal and the Security tab's
 * safeguard cards, bundled into one object rather than three separate
 * booleans passed down in parallel - so the seal's pips, the pillar list,
 * and the verdict text (and Security's own status rows) always read the
 * exact same snapshot and can never show conflicting answers for the same
 * instant, even though all three ultimately come from three independent
 * OS-level queries (accessibility service list, device admin state, battery
 * optimization exemption).
 */
data class SafeguardState(
    val accessibilityEnabled: Boolean,
    val deviceAdminActive: Boolean,
    val batteryOptimizationIgnored: Boolean,
) {
    val allActive: Boolean get() = accessibilityEnabled && deviceAdminActive && batteryOptimizationIgnored
}
