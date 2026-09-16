/*
  ESP32-S3 (XIAO Sense) — On-Demand Capture, 5-Photo Rotation + Real Timestamps
  ---------------------------------------------------------------------------------
  Two fixes/additions in this version:

  1. REAL TIMESTAMP FIX: previous version used millis()/1000 (seconds since
     boot — a tiny number) instead of a real Unix timestamp. This silently
     broke the dashboard's "is this capture done yet?" check, since a tiny
     boot-relative number can never be "newer than" the dashboard's real
     Unix-timestamp request. Now syncs NTP time at boot, matching the
     master board's approach, and uses time(nullptr) for a real timestamp.

  2. 5-PHOTO ROTATION: instead of one fixed "latest.jpg" that gets
     overwritten every time, this cycles through 5 filenames
     (camera/photo_0.jpg ... camera/photo_4.jpg) round-robin. The rotation
     index is saved via Preferences so it survives a reboot. RTDB gets a
     small photos/0..4 list with each slot's URL + timestamp, so the
     dashboard can show a gallery of the last 5 shots.

  3. CAMERA HEARTBEAT: writes sensors/camera/last_seen every 30s so the
     dashboard can independently show "Camera Online/Offline", separate
     from the master board's own status.

  Firebase Storage requires the Blaze plan (already active on this project).

  Libraries required (Arduino IDE > Library Manager):
    - "Firebase ESP Client" by Mobizt — LATEST version (do not downgrade,
      an older version fails to compile against current ESP32 cores)
    - "WiFiManager" by tzapu

  Board: Seeed XIAO ESP32-S3 Sense (with camera + PSRAM enabled)
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <Firebase_ESP_Client.h>
#include "esp_camera.h"
#include <esp_task_wdt.h>
#include <Preferences.h>
#include <time.h>

#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

#define WDT_TIMEOUT_SEC 20

// ---------- USER CONFIG ----------
#define API_KEY         "AIzaSyBI0M_IbK294nLJn_SOOEngGO91e0nhdT4"
#define STORAGE_BUCKET  "iigs-sp.firebasestorage.app"
#define DATABASE_URL    "https://iigs-sp-default-rtdb.asia-southeast1.firebasedatabase.app"

const char* SETUP_AP_NAME = "ESP32-Cam-Setup";
const unsigned int WIFI_PORTAL_TIMEOUT_SEC = 180;
const unsigned long POLL_INTERVAL_MS = 3000;

const char* ntpServer = "pool.ntp.org";
const long gmtOffset_sec = 25200; // matches master board's timezone offset
const int daylightOffset_sec = 0;

// ---------- 5-PHOTO ROTATION ----------
const int PHOTO_SLOT_COUNT = 5;
Preferences photoPrefs;
int currentSlot = 0; // which of the 5 slots to use next, persisted across reboots

const char* PATH_CAPTURE_REQUESTED = "/sensors/camera/captureRequested";
const char* PATH_LATEST_IMAGE_URL  = "/sensors/camera/latestImageUrl";
const char* PATH_LAST_IMAGE_TIME   = "/sensors/camera/lastImageTimestamp";
const char* PATH_CAPTURE_ERROR     = "/sensors/camera/captureError";
const char* PATH_CAMERA_LAST_SEEN  = "/sensors/camera/last_seen";

unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL_MS = 30000; // same cadence as the master board

// ---------- FIREBASE OBJECTS ----------
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

unsigned long lastPoll = 0;
bool firebaseReady = false;
long lastHandledRequest = -1;

// ---------- CAMERA CONFIG (XIAO ESP32-S3 Sense pin map) ----------
#define PWDN_GPIO_NUM     -1
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM     10
#define SIOD_GPIO_NUM     40
#define SIOC_GPIO_NUM     39
#define Y9_GPIO_NUM       48
#define Y8_GPIO_NUM       11
#define Y7_GPIO_NUM       12
#define Y6_GPIO_NUM       14
#define Y5_GPIO_NUM       16
#define Y4_GPIO_NUM       18
#define Y3_GPIO_NUM       17
#define Y2_GPIO_NUM       15
#define VSYNC_GPIO_NUM    38
#define HREF_GPIO_NUM     47
#define PCLK_GPIO_NUM     13

bool initCamera() {
  camera_config_t cfg;
  cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.ledc_timer = LEDC_TIMER_0;
  cfg.pin_d0 = Y2_GPIO_NUM;
  cfg.pin_d1 = Y3_GPIO_NUM;
  cfg.pin_d2 = Y4_GPIO_NUM;
  cfg.pin_d3 = Y5_GPIO_NUM;
  cfg.pin_d4 = Y6_GPIO_NUM;
  cfg.pin_d5 = Y7_GPIO_NUM;
  cfg.pin_d6 = Y8_GPIO_NUM;
  cfg.pin_d7 = Y9_GPIO_NUM;
  cfg.pin_xclk = XCLK_GPIO_NUM;
  cfg.pin_pclk = PCLK_GPIO_NUM;
  cfg.pin_vsync = VSYNC_GPIO_NUM;
  cfg.pin_href = HREF_GPIO_NUM;
  cfg.pin_sccb_sda = SIOD_GPIO_NUM;
  cfg.pin_sccb_scl = SIOC_GPIO_NUM;
  cfg.pin_pwdn = PWDN_GPIO_NUM;
  cfg.pin_reset = RESET_GPIO_NUM;
  cfg.xclk_freq_hz = 20000000;
  cfg.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    cfg.frame_size = FRAMESIZE_SVGA;
    cfg.jpeg_quality = 10;
    cfg.fb_count = 2;
    cfg.fb_location = CAMERA_FB_IN_PSRAM;
    cfg.grab_mode = CAMERA_GRAB_LATEST;
  } else {
    cfg.frame_size = FRAMESIZE_VGA;
    cfg.jpeg_quality = 12;
    cfg.fb_count = 1;
    cfg.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  }

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }
  return true;
}

void connectWiFi() {
  WiFiManager wm;
  wm.setConfigPortalTimeout(WIFI_PORTAL_TIMEOUT_SEC);

  Serial.println("Attempting Wi-Fi connection (saved credentials first)...");
  bool connected = wm.autoConnect(SETUP_AP_NAME);

  if (!connected) {
    Serial.println("Wi-Fi setup timed out with no connection. Rebooting to retry...");
    delay(1000);
    ESP.restart();
  }

  Serial.println("Wi-Fi connected: " + WiFi.localIP().toString());
}

void initTime() {
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
  struct tm timeinfo;
  int timeTimeout = 0;
  Serial.print("Syncing time");
  while (!getLocalTime(&timeinfo) && timeTimeout < 15) {
    delay(1000);
    Serial.print(".");
    timeTimeout++;
  }
  Serial.println(timeTimeout >= 15 ? "\nTime sync failed (continuing anyway)." : "\nTime synced successfully!");
}

// Builds the download URL for a GIVEN slot's file path.
String buildDownloadUrl(String path) {
  if (path.startsWith("/")) path.remove(0, 1);
  path.replace("/", "%2F");
  return "https://firebasestorage.googleapis.com/v0/b/" + String(STORAGE_BUCKET) +
         "/o/" + path + "?alt=media";
}

void initFirebase() {
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;

  Serial.println("Attempting anonymous sign-up...");
  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Anonymous sign-up successful.");
  } else {
    Serial.println("Sign-up FAILED: " + String(config.signer.signupError.message.c_str()));
  }

  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  fbdo.setBSSLBufferSize(4096, 1024);

  Serial.println("Waiting for Firebase auth...");
  unsigned long start = millis();
  while (auth.token.uid.length() == 0 && millis() - start < 15000) {
    delay(200);
  }
  firebaseReady = (auth.token.uid.length() > 0);
  Serial.println(firebaseReady ? "Firebase ready." : "Firebase auth timed out.");
}

long readCaptureRequested() {
  if (Firebase.RTDB.getInt(&fbdo, PATH_CAPTURE_REQUESTED)) {
    return fbdo.intData();
  }
  return -1;
}

void captureAndUpload() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed.");
    return;
  }

  // Round-robin file path: camera/photo_0.jpg ... camera/photo_4.jpg
  String slotPath = "camera/photo_" + String(currentSlot) + ".jpg";
  Serial.printf("Captured frame: %d bytes. Uploading to slot %d (%s)...\n",
                fb->len, currentSlot, slotPath.c_str());

  bool uploadOk = Firebase.Storage.upload(
    &fbdo, STORAGE_BUCKET, fb->buf, fb->len,
    slotPath.c_str(), "image/jpeg"
  );

  esp_camera_fb_return(fb);

  if (!uploadOk) {
    Serial.println("Storage upload failed: " + fbdo.errorReason());
    Firebase.RTDB.setString(&fbdo, PATH_CAPTURE_ERROR, "Upload failed");
    return;
  }

  String downloadUrl = buildDownloadUrl(slotPath);
  int timestamp = (int)time(nullptr); // REAL Unix timestamp now, not millis()/1000

  Serial.println("Uploaded. URL: " + downloadUrl);

  // Write this slot's entry into the rotating gallery list.
  String slotUrlPath = "/sensors/camera/photos/" + String(currentSlot) + "/url";
  String slotTsPath  = "/sensors/camera/photos/" + String(currentSlot) + "/timestamp";
  Firebase.RTDB.setString(&fbdo, slotUrlPath.c_str(), downloadUrl);
  Firebase.RTDB.setInt(&fbdo, slotTsPath.c_str(), timestamp);

  // Also update the "latest" convenience fields the main dashboard card uses.
  Firebase.RTDB.setString(&fbdo, PATH_LATEST_IMAGE_URL, downloadUrl);
  Firebase.RTDB.setInt(&fbdo, PATH_LAST_IMAGE_TIME, timestamp);
  Firebase.RTDB.deleteNode(&fbdo, PATH_CAPTURE_ERROR);

  // Advance to the next slot for the FOLLOWING capture, and persist it.
  currentSlot = (currentSlot + 1) % PHOTO_SLOT_COUNT;
  photoPrefs.putInt("slot", currentSlot);
}

void setup() {
  Serial.begin(115200);
  delay(500);

  esp_task_wdt_config_t wdt_config = {
    .timeout_ms = WDT_TIMEOUT_SEC * 1000,
    .idle_core_mask = 0,
    .trigger_panic = true
  };
  esp_task_wdt_reconfigure(&wdt_config);
  esp_task_wdt_add(NULL);

  photoPrefs.begin("photorot", false);
  currentSlot = photoPrefs.getInt("slot", 0);
  Serial.printf("Resuming photo rotation at slot %d\n", currentSlot);

  if (!initCamera()) {
    Serial.println("Halting: camera init failed.");
    while (true) delay(1000);
  }

  connectWiFi();
  initTime();
  initFirebase();
}

void loop() {
  esp_task_wdt_reset();

  if (firebaseReady && millis() - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = millis();

    long requestValue = readCaptureRequested();

    if (requestValue != -1 && requestValue != lastHandledRequest) {
      lastHandledRequest = requestValue;
      Serial.printf("Capture requested (trigger=%ld). Capturing...\n", requestValue);
      captureAndUpload();
    }
  }

  // Heartbeat: same pattern as the master board — report "still alive"
  // every 30s so the dashboard can independently track THIS board's
  // online/offline status, separate from the master's.
  if (firebaseReady && millis() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = millis();
    Firebase.RTDB.setInt(&fbdo, PATH_CAMERA_LAST_SEEN, (int)time(nullptr));
  }
}