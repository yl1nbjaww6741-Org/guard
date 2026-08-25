// Every built-in Apple app on this project's real Mac, pinned to the top
// of the dashboard's Installed Apps table - see dashboard.ts's
// loadInstalledApps() for how they're merged in. Added because Fleet's
// macOS applications inventory (softwareApi.ts's handleListInstalledSoftware,
// `macos_applications=true`) isn't reliable for apps living in
// /System/Applications the way it is for /Applications - a real
// first-party Apple app can go missing from that list even though it's
// obviously installed, which made it impossible to whitelist/block/allow
// by name the way every other app on this dashboard already works,
// exactly the "add new apps only by title, not bundle ID" requirement
// this whole Installed Apps table exists for.
//
// Bundle IDs below are REAL, not guessed - read directly off the actual
// Info.plist of every app under /System/Applications(/Utilities) and
// /Applications on the real Mac this project protects:
//   for d in /System/Applications/*.app /System/Applications/Utilities/*.app /Applications/*.app; do
//     id=$(defaults read "$d/Contents/Info" CFBundleIdentifier 2>/dev/null)
//     echo "$(basename "$d" .app) | $id"
//   done | sort
// then filtered down to the com.apple.* results (which also mechanically
// excludes every third-party app the same scan turned up - Chrome,
// Spotify, Tor Browser, Santa itself, etc. - without needing a manual
// exclude list). Terminal/Finder/System Settings/Xcode/Activity Monitor
// are deliberately left out here even though the scan found them too -
// they're already permanently whitelisted via Config.swift's compiled
// safeAppBundleIDs baseline (see staticSafeApps.ts), so listing them
// again here would just be a confusing duplicate "Whitelist" button for
// something that's already whitelisted forever.
//
// Same "no live channel to the Mac, mirror by hand" reasoning as
// staticSafeApps.ts/staticRules.ts - this needs re-running by hand if a
// macOS upgrade adds/renames/removes a built-in app.
export interface KnownAppEntry {
  bundleId: string;
  name: string;
}

export const KNOWN_APPLE_APPS: KnownAppEntry[] = [
  { bundleId: "com.apple.airport.airportutility", name: "AirPort Utility" },
  { bundleId: "com.apple.AppStore", name: "App Store" },
  { bundleId: "com.apple.apps.launcher", name: "Apps" },
  { bundleId: "com.apple.audio.AudioMIDISetup", name: "Audio MIDI Setup" },
  { bundleId: "com.apple.Automator", name: "Automator" },
  { bundleId: "com.apple.BluetoothFileExchange", name: "Bluetooth File Exchange" },
  { bundleId: "com.apple.iBooksX", name: "Books" },
  { bundleId: "com.apple.bootcampassistant", name: "Boot Camp Assistant" },
  { bundleId: "com.apple.calculator", name: "Calculator" },
  { bundleId: "com.apple.iCal", name: "Calendar" },
  { bundleId: "com.apple.Chess", name: "Chess" },
  { bundleId: "com.apple.clock", name: "Clock" },
  { bundleId: "com.apple.ColorSyncUtility", name: "ColorSync Utility" },
  { bundleId: "com.apple.Console", name: "Console" },
  { bundleId: "com.apple.AddressBook", name: "Contacts" },
  { bundleId: "com.apple.Dictionary", name: "Dictionary" },
  { bundleId: "com.apple.DigitalColorMeter", name: "Digital Color Meter" },
  { bundleId: "com.apple.DiskUtility", name: "Disk Utility" },
  { bundleId: "com.apple.FaceTime", name: "FaceTime" },
  { bundleId: "com.apple.findmy", name: "Find My" },
  { bundleId: "com.apple.FontBook", name: "Font Book" },
  { bundleId: "com.apple.freeform", name: "Freeform" },
  { bundleId: "com.apple.games", name: "Games" },
  { bundleId: "com.apple.garageband10", name: "GarageBand" },
  { bundleId: "com.apple.grapher", name: "Grapher" },
  { bundleId: "com.apple.Home", name: "Home" },
  { bundleId: "com.apple.Image_Capture", name: "Image Capture" },
  { bundleId: "com.apple.GenerativePlaygroundApp", name: "Image Playground" },
  { bundleId: "com.apple.iMovieApp", name: "iMovie" },
  { bundleId: "com.apple.ScreenContinuity", name: "iPhone Mirroring" },
  { bundleId: "com.apple.journal", name: "Journal" },
  { bundleId: "com.apple.Magnifier", name: "Magnifier" },
  { bundleId: "com.apple.mail", name: "Mail" },
  { bundleId: "com.apple.Maps", name: "Maps" },
  { bundleId: "com.apple.MobileSMS", name: "Messages" },
  { bundleId: "com.apple.MigrateAssistant", name: "Migration Assistant" },
  { bundleId: "com.apple.exposelauncher", name: "Mission Control" },
  { bundleId: "com.apple.Music", name: "Music" },
  { bundleId: "com.apple.news", name: "News" },
  { bundleId: "com.apple.Notes", name: "Notes" },
  { bundleId: "com.apple.iWork.Numbers", name: "Numbers" },
  { bundleId: "com.apple.iWork.Pages", name: "Pages" },
  { bundleId: "com.apple.Passwords", name: "Passwords" },
  { bundleId: "com.apple.mobilephone", name: "Phone" },
  { bundleId: "com.apple.PhotoBooth", name: "Photo Booth" },
  { bundleId: "com.apple.Photos", name: "Photos" },
  { bundleId: "com.apple.podcasts", name: "Podcasts" },
  { bundleId: "com.apple.Preview", name: "Preview" },
  { bundleId: "com.apple.printcenter", name: "Print Center" },
  { bundleId: "com.apple.QuickTimePlayerX", name: "QuickTime Player" },
  { bundleId: "com.apple.reminders", name: "Reminders" },
  { bundleId: "com.apple.Safari", name: "Safari" },
  { bundleId: "com.apple.ScreenSharing", name: "Screen Sharing" },
  { bundleId: "com.apple.screenshot.launcher", name: "Screenshot" },
  { bundleId: "com.apple.ScriptEditor2", name: "Script Editor" },
  { bundleId: "com.apple.shortcuts", name: "Shortcuts" },
  { bundleId: "com.apple.siri.launcher", name: "Siri" },
  { bundleId: "com.apple.Stickies", name: "Stickies" },
  { bundleId: "com.apple.stocks", name: "Stocks" },
  { bundleId: "com.apple.SystemProfiler", name: "System Information" },
  { bundleId: "com.apple.TextEdit", name: "TextEdit" },
  { bundleId: "com.apple.backup.launcher", name: "Time Machine" },
  { bundleId: "com.apple.helpviewer", name: "Tips" },
  { bundleId: "com.apple.TV", name: "TV" },
  { bundleId: "com.apple.VoiceMemos", name: "Voice Memos" },
  { bundleId: "com.apple.VoiceOverUtility", name: "VoiceOver Utility" },
  { bundleId: "com.apple.weather", name: "Weather" },
];
