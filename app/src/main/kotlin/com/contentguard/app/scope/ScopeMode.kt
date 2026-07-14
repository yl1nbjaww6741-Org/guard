package com.contentguard.app.scope

/**
 * MONITOR_ALL_EXCEPT_WHITELIST: default. Everything is monitored except
 * apps the user has explicitly trusted - the headline "set it and forget
 * it" mode.
 *
 * MONITOR_ONLY_LISTED: opt-in per app. Useful for a narrow, high-risk set
 * (e.g. just the browser) without paying the cascade's cost anywhere else.
 */
enum class ScopeMode {
    MONITOR_ALL_EXCEPT_WHITELIST,
    MONITOR_ONLY_LISTED,
}
