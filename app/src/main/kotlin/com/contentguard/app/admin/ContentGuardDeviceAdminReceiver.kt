package com.contentguard.app.admin

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import com.contentguard.app.R

/**
 * Device Admin, not Device Owner - no factory reset or MDM enrollment
 * needed. Simply being an active administrator is what makes the system
 * grey out "Force stop" and "Uninstall" for this app in Settings > Apps;
 * that comes from admin status itself, which is why uses-policies in
 * device_admin_receiver.xml is empty - no specific policy is needed.
 */
class ContentGuardDeviceAdminReceiver : DeviceAdminReceiver() {

    override fun onDisableRequested(context: Context, intent: Intent): CharSequence {
        return context.getString(R.string.device_admin_disable_warning)
    }
}
