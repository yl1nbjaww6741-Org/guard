plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.contentguard.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.contentguard.app"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // Needed to run the throwaway NNAPI-engagement spike in
        // androidTest/ via `./gradlew connectedAndroidTest`.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // assets/320n.onnx (gate 7's live model, see NudeNetDetector.kt) is
    // committed via Git LFS. The legacy assets/nsfw.onnx/nsfw.tflite
    // fallbacks are intentionally not shipped - NsfwClassifierFactory falls
    // back to StubNsfwClassifier when none of the three are present. Avoid
    // aapt compressing model assets - a compressed model can't be mmap'd.
    androidResources {
        noCompress += listOf("tflite", "onnx")
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
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // TensorFlow Lite - legacy gate-7 backend, kept for existing
    // assets/nsfw.tflite conversions. `tensorflow-lite` is the interpreter
    // runtime; `tensorflow-lite-support` gives us TensorImage/TensorBuffer
    // helpers for the fixed-size quantized input the NSFW model expects.
    implementation("org.tensorflow:tensorflow-lite:2.16.1")
    implementation("org.tensorflow:tensorflow-lite-support:0.4.4")

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
