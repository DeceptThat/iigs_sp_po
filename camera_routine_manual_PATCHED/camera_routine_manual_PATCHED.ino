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

#define WDT_TIMEOUT_SEC 60

#define API_KEY         "AIzaSyBI0M_IbK294nLJn_SOOEngGO91e0nhdT4"
#define STORAGE_BUCKET  "iigs-sp.firebasestorage.app"

#define DATABASE_URL    "https://iigs-sp.firebaseio.com"

const char* SETUP_AP_NAME = "ESP32-Cam-Setup";
const unsigned int WIFI_PORTAL_TIMEOUT_SEC = 180;
const unsigned long POLL_INTERVAL_MS = 1000;

const char* ntpServer = "pool.ntp.org";
const long gmtOffset_sec = 25200;
const int daylightOffset_sec = 0;

const char* PATH_CONTROL_REQUEST = "/sensors/camera/control/capture_requested";
const char* PATH_CONTROL_TARGET  = "/sensors/camera/control/capture_target";
const char* PATH_CONTROL_SET     = "/sensors/camera/control/capture_set";
const char* PATH_CONTROL_FRAME   = "/sensors/camera/control/capture_frame";
const char* PATH_CAPTURE_ERROR   = "/sensors/camera/captureError";
const char* PATH_CAMERA_NODE     = "/sensors/camera";

Preferences prefs;
int checkCount   = 0;
unsigned int bootCount = 0;

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

unsigned long lastPoll = 0;
unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL_MS = 30000;
bool firebaseReady = false;
long lastHandledRequest = -1;
unsigned long lastCaptureAt = 0;

const unsigned long RESTART_INTERVAL_MS = 30UL * 60UL * 1000UL;
const unsigned long RESTART_QUIET_MS    = 60UL * 1000UL;

#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  10
#define SIOD_GPIO_NUM  40
#define SIOC_GPIO_NUM  39
#define Y9_GPIO_NUM    48
#define Y8_GPIO_NUM    11
#define Y7_GPIO_NUM    12
#define Y6_GPIO_NUM    14
#define Y5_GPIO_NUM    16
#define Y4_GPIO_NUM    18
#define Y3_GPIO_NUM    17
#define Y2_GPIO_NUM    15
#define VSYNC_GPIO_NUM 38
#define HREF_GPIO_NUM  47
#define PCLK_GPIO_NUM  13

void printMemory(const char* label) {
  uint32_t dFree = ESP.getFreeHeap(),  dMax = ESP.getMaxAllocHeap();
  uint32_t pFree = ESP.getFreePsram(), pMax = ESP.getMaxAllocPsram();
  Serial.printf("[MEM %s] DRAM free=%u max=%u F=%.4f | PSRAM free=%u max=%u F=%.4f\n",
    label, dFree, dMax, dFree ? 1.0f - (float)dMax/(float)dFree : 0.0f,
    pFree, pMax, pFree ? 1.0f - (float)pMax/(float)pFree : 0.0f);
}

bool initCamera() {

  camera_config_t cfg = {};
  cfg.sccb_i2c_port = -1;

  cfg.ledc_channel = LEDC_CHANNEL_0;  cfg.ledc_timer = LEDC_TIMER_0;
  cfg.pin_d0 = Y2_GPIO_NUM;  cfg.pin_d1 = Y3_GPIO_NUM;
  cfg.pin_d2 = Y4_GPIO_NUM;  cfg.pin_d3 = Y5_GPIO_NUM;
  cfg.pin_d4 = Y6_GPIO_NUM;  cfg.pin_d5 = Y7_GPIO_NUM;
  cfg.pin_d6 = Y8_GPIO_NUM;  cfg.pin_d7 = Y9_GPIO_NUM;
  cfg.pin_xclk = XCLK_GPIO_NUM;     cfg.pin_pclk = PCLK_GPIO_NUM;
  cfg.pin_vsync = VSYNC_GPIO_NUM;   cfg.pin_href = HREF_GPIO_NUM;
  cfg.pin_sccb_sda = SIOD_GPIO_NUM; cfg.pin_sccb_scl = SIOC_GPIO_NUM;
  cfg.pin_pwdn = PWDN_GPIO_NUM;     cfg.pin_reset = RESET_GPIO_NUM;
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
    cfg.fb_location = CAMERA_FB_IN_DRAM;
    cfg.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  }

  esp_err_t err = esp_camera_init(&cfg);

  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x - retrying with one VGA buffer\n", err);
    esp_camera_deinit();
    delay(200);
    cfg.frame_size   = FRAMESIZE_VGA;
    cfg.jpeg_quality = 12;
    cfg.fb_count     = 1;
    cfg.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
    err = esp_camera_init(&cfg);
    if (err == ESP_OK) Serial.println("Camera started in the reduced configuration.");
  }

  if (err != ESP_OK) { Serial.printf("Camera init failed: 0x%x\n", err); return false; }
  return true;
}

void connectWiFi() {
  WiFiManager wm;
  wm.setConfigPortalTimeout(WIFI_PORTAL_TIMEOUT_SEC);
  Serial.println("Attempting Wi-Fi connection...");
  if (!wm.autoConnect(SETUP_AP_NAME)) {
    Serial.println("Wi-Fi setup timed out. Rebooting...");
    delay(1000); ESP.restart();
  }
  Serial.println("Wi-Fi connected: " + WiFi.localIP().toString());
}

void initTime() {
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
  struct tm ti; int t = 0;
  Serial.print("Syncing time");
  while (!getLocalTime(&ti) && t < 15) { delay(1000); Serial.print("."); esp_task_wdt_reset(); t++; }
  Serial.println(t >= 15 ? "\nTime sync failed." : "\nTime synced.");
}

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
  if (Firebase.signUp(&config, &auth, "", "")) Serial.println("Anonymous sign-up successful.");
  else Serial.println("Sign-up FAILED: " + String(config.signer.signupError.message.c_str()));

  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
  fbdo.setBSSLBufferSize(4096, 1024);

  Serial.print("Waiting for Firebase auth");
  unsigned long start = millis();
  while (!Firebase.ready() && millis() - start < 20000) {
    delay(250); Serial.print("."); esp_task_wdt_reset();
  }
  firebaseReady = Firebase.ready();
  Serial.println(firebaseReady ? " ready." : " TIMED OUT.");
}

void updateLiveTelemetry() {
  if (!firebaseReady) return;
  FirebaseJson j;
  j.set("last_seen",       (int)time(nullptr));
  j.set("uptime_s",        (int)(millis() / 1000));
  j.set("boot_count",      (int)bootCount);
  j.set("free_heap",       (int)ESP.getFreeHeap());
  j.set("max_alloc_heap",  (int)ESP.getMaxAllocHeap());
  j.set("free_psram",      (int)ESP.getFreePsram());
  j.set("max_alloc_psram", (int)ESP.getMaxAllocPsram());
  Firebase.RTDB.updateNode(&fbdo, PATH_CAMERA_NODE, &j);
  esp_task_wdt_reset();
}

long readCaptureRequest() {
  if (Firebase.RTDB.getInt(&fbdo, PATH_CONTROL_REQUEST)) return fbdo.intData();
  return -1;
}

String readCaptureTarget() {
  if (Firebase.RTDB.getString(&fbdo, PATH_CONTROL_TARGET)) {
    String t = fbdo.stringData();
    t.replace("\"", "");
    if (t == "routine" || t == "check") return t;
  }

  return "check";
}

int readControlInt(const char* path, int fallback) {
  if (Firebase.RTDB.getInt(&fbdo, path)) return fbdo.intData();
  return fallback;
}

bool cameraReady = false;

void captureAndUpload() {
  lastCaptureAt = millis();
  if (!cameraReady) {
    Serial.println("Capture requested but the camera did not initialise.");
    Firebase.RTDB.setString(&fbdo, PATH_CAPTURE_ERROR,
                            "camera init failed - check the ribbon connector");
    esp_task_wdt_reset();
    return;
  }
  String target = readCaptureTarget();
  bool isRoutine = (target == "routine");

  int set   = readControlInt(PATH_CONTROL_SET, -1);
  int frame = readControlInt(PATH_CONTROL_FRAME, 0);

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed.");
    Firebase.RTDB.setString(&fbdo, PATH_CAPTURE_ERROR, "frame grab failed");
    esp_task_wdt_reset();
    return;
  }

  int ts = (int)time(nullptr);

  String path = (isRoutine && set >= 0)
      ? "camera/routine/" + String(set) + "/" + String(frame) + ".jpg"
      : "camera/" + target + "/" + String(ts) + ".jpg";

  Serial.printf("Captured %d bytes -> %s\n", fb->len, path.c_str());
  printMemory("pre-upload");

  bool ok = Firebase.Storage.upload(&fbdo, STORAGE_BUCKET, fb->buf, fb->len,
                                    path.c_str(), "image/jpeg");
  esp_camera_fb_return(fb);
  esp_task_wdt_reset();

  if (!ok) {
    Serial.println("Storage upload failed: " + fbdo.errorReason());
    Firebase.RTDB.setString(&fbdo, PATH_CAPTURE_ERROR, "upload failed");
    esp_task_wdt_reset();
    return;
  }

  String url = buildDownloadUrl(path);
  Serial.println("Uploaded: " + url);

  FirebaseJson entry;
  entry.set("url", url);
  entry.set("timestamp", ts);
  entry.set("storage_path", path);

  if (isRoutine && set >= 0) {
    entry.set("set", set);
    entry.set("frame", frame);
    String node = "/sensors/camera/routine/" + String(set) + "/" + String(frame);
    Firebase.RTDB.updateNode(&fbdo, node.c_str(), &entry);
  } else {

    String node = "/sensors/camera/" + target + "/" + String(ts);
    Firebase.RTDB.updateNode(&fbdo, node.c_str(), &entry);
  }
  esp_task_wdt_reset();

  FirebaseJson latest;
  latest.set("latestImageUrl", url);
  latest.set("lastImageTimestamp", ts);
  latest.set("lastImageTarget", target);
  Firebase.RTDB.updateNode(&fbdo, PATH_CAMERA_NODE, &latest);
  Firebase.RTDB.deleteNode(&fbdo, PATH_CAPTURE_ERROR);
  esp_task_wdt_reset();

  if (!isRoutine) {
    checkCount++;
    prefs.putInt("ccount", checkCount);

  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  prefs.begin("camera", false);
  checkCount  = prefs.getInt("ccount", 0);
  bootCount   = prefs.getUInt("boots", 0) + 1;
  prefs.putUInt("boots", bootCount);

  lastHandledRequest = prefs.getLong("lastreq", -1);
  if (lastHandledRequest > 0) {
    Serial.printf("[BOOT] last handled capture request was %ld\n", lastHandledRequest);
  }

  Serial.printf("PSRAM present: %s, size %u B\n",
                psramFound() ? "YES" : "NO", ESP.getPsramSize());
  printMemory("boot-baseline");

  bool cameraOk = initCamera();
  cameraReady = cameraOk;
  if (!cameraOk) Serial.println("Continuing without the camera so the fault can be reported.");
  printMemory("post-camera-init");

  connectWiFi();

  esp_task_wdt_config_t wdt = { .timeout_ms = WDT_TIMEOUT_SEC * 1000,
                                .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_reconfigure(&wdt);
  esp_task_wdt_add(NULL);

  initTime();
  initFirebase();
  printMemory("post-firebase-init");

  if (firebaseReady && lastHandledRequest <= 0) {
    long pending = readCaptureRequest();
    if (pending > 0) {
      lastHandledRequest = pending;
      prefs.putLong("lastreq", pending);
      Serial.printf("[BOOT] adopting capture request %ld left from before this restart\n",
                    pending);
    }
  }

  if (!cameraOk && firebaseReady) {
    Firebase.RTDB.setString(&fbdo, PATH_CAPTURE_ERROR,
                            "camera init failed - check the ribbon connector");
  }

  updateLiveTelemetry();
}

void loop() {
  esp_task_wdt_reset();

  if (firebaseReady && millis() - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = millis();
    long req = readCaptureRequest();
    esp_task_wdt_reset();
    if (req > 0 && req != lastHandledRequest) {

      lastHandledRequest = req;
      prefs.putLong("lastreq", req);
      Serial.printf("\nCapture requested (trigger=%ld)\n", req);
      captureAndUpload();
      esp_task_wdt_reset();
    }
  }

  if (firebaseReady && millis() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = millis();
    updateLiveTelemetry();
  }

  if (millis() > RESTART_INTERVAL_MS &&
      (lastCaptureAt == 0 || millis() - lastCaptureAt > RESTART_QUIET_MS)) {
    Serial.printf("[MAINT] scheduled restart after %lu min\n",
                  RESTART_INTERVAL_MS / 60000UL);
    if (firebaseReady) {
      Firebase.RTDB.setInt(&fbdo, "/sensors/camera/last_scheduled_restart",
                           (int)time(nullptr));
    }
    delay(300);
    ESP.restart();
  }
}
