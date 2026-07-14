# TensorFlow Lite loads native code and reflects into its own classes;
# keep it intact under R8.
-keep class org.tensorflow.lite.** { *; }
-dontwarn org.tensorflow.lite.**
