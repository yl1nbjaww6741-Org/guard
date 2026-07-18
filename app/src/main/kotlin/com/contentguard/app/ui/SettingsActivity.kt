package com.contentguard.app.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.ui.theme.ContentGuardTheme

class SettingsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = PrefsRepository(applicationContext)
        setContent {
            ContentGuardTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    ContentGuardApp(prefs)
                }
            }
        }
    }
}
