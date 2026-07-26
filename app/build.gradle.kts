plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Minutes since 2024-01-01T00:00:00Z, so every build gets a strictly
// larger versionCode than the last one - a static versionCode meant every
// build compared equal, so Android's stock downgrade check
// (INSTALL_FAILED_VERSION_DOWNGRADE, which only fires on a *lower*
// versionCode) never actually refused installing an older/weaker saved
// APK over whatever's currently installed. Time-based rather than a git
// commit count so it doesn't depend on CI's checkout fetching full
// history (this repo's checkout is shallow) and works the same for local
// builds without a git history at all.
val versionCodeFromBuildTime = ((System.currentTimeMillis() / 1000 / 60) - 28401120L).toInt()

android {
    namespace = "com.contentguard.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.contentguard.app"
        minSdk = 30
        targetSdk = 35
        versionCode = versionCodeFromBuildTime
        versionName = "0.1.0"
        // Needed to run the throwaway NNAPI-engagement spike in
        // androidTest/ via `./gradlew connectedAndroidTest`.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // arm64 only. ONNX Runtime ships a ~28MB native library per ABI, so
        // the default "every ABI" build spent ~95MB of a ~158MB APK on code
        // this app can never execute: x86/x86_64 are emulator-only, and
        // armeabi-v7a is 32-bit ARM, which no minSdk-30 device in this app's
        // target range ships. Since distribution is a single sideloaded APK
        // from a GitHub Release (see SETUP.md) rather than Play's per-device
        // splits, every one of those bytes was downloaded and stored by the
        // one real arm64 device that runs this.
        //
        // Add "x86_64" back here temporarily if you ever need to run this on
        // an Android emulator - nothing else has to change.
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    // assets/320n.onnx (gate 7's live model, see NudeNetDetector.kt) is
    // committed via Git LFS and is the only model shipped. The legacy
    // assets/nsfw.onnx fallback is deliberately not committed (see
    // assets/PLACE_MODEL_HERE.txt) - NsfwClassifierFactory falls back to
    // StubNsfwClassifier if neither is present. Avoid aapt compressing model
    // assets - a compressed model can't be mmap'd.
    androidResources {
        noCompress += listOf("onnx")
    }

    signingConfigs {
        // Overrides AGP's built-in "debug" config, which otherwise
        // auto-generates a new ~/.android/debug.keystore per machine - on
        // GitHub Actions that means a brand-new key on every run, so
        // Android refuses to install a new build over the last one
        // ("something went wrong") and forces an uninstall (wiping
        // SharedPreferences - whitelist, threshold, etc). Committing a
        // fixed keystore here means every CI run and every local build
        // signs with the same key, so updates always install in place.
        // Not a secret: debug-only, well-known store/key password, no
        // real trust value - same convention as AGP's own default.
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        // AGP 8+ no longer generates BuildConfig by default; AppScopePolicy
        // reads BuildConfig.APPLICATION_ID to hard-exclude our own package
        // (including the ".debug" applicationIdSuffix) without hardcoding it.
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")

    // Compose (BOM pins all compose artifact versions together)
    val composeBom = platform("androidx.compose:compose-bom:2024.10.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    // Crossfade() for the redesigned Settings UI's tab-switch transition -
    // not reliably pulled in transitively by material3 alone.
    implementation("androidx.compose.animation:animation")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // No TensorFlow Lite. It was carried for TFLiteNsfwClassifier, a
    // deliberately unimplemented skeleton for a hypothetical
    // assets/nsfw.tflite that was never committed - so the code path could
    // not activate in any shipped build, while libtensorflowlite_jni.so was
    // packaged into every APK regardless. Gate 7 runs on ONNX Runtime below,
    // which already serves both the live model and its legacy fallback. To
    // restore the TFLite path, recover TFLiteNsfwClassifier.kt and these two
    // dependencies from git history and re-add the branch in
    // NsfwClassifierFactory.

    // ONNX Runtime Mobile - primary gate-7 backend (assets/320n.onnx, see
    // NudeNetDetector). This build includes the XNNPACK EP (CPU, thread-
    // pooled) with automatic plain-CPU-EP fallback if XNNPACK init fails;
    // also used by the legacy OnnxNsfwClassifier fallback (NNAPI-preferring).
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.27.0")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
}
