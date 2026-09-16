/*
  BOARD A — Firebase Relay (Wi-Fi + Firebase ONLY, nothing else)
  -------------------------------------------------------------------
  Purpose: maximize free RAM available for Firebase's TLS handshake by
  running NOTHING else alongside it — no motor, no Preferences/NVS
  access, no other library competing for memory at the exact moment
  a Firebase call needs a big contiguous chunk for SSL buffers.

  Two SEPARATE wired UART links from this board:

    1. Serial1 (pins 32/33) <-> SENSOR BOARD (unchanged from before —
       same wiring, same "W:1"/"W:0" protocol, that board's code
       doesn't need to change at all)

    2. Serial2 (pins 16/17) <-> CRASHHANDLER board (motor + logging)
       Sends "MOTOR:<angle>" when motor_angle changes in Firebase,
       and a one-time "BOOT" message right after this board starts,
       so crashHandler can log how often THIS board has to reboot —
       useful since this is still the board most likely to occasionally
       need a reset from an SSL hang, even with the watchdog fix.

  Libraries required (Arduino IDE > Library Manager):
    - "Firebase ESP32" by Mobizt (FirebaseESP32.h)
    - "WiFiManager" by tzapu
*/

#include <WiFi.h>
#include <WiFiManager.h>
#include <FirebaseESP32.h>
#include <time.h>
#include <esp_task_wdt.h>

#define WDT_TIMEOUT_SEC 20

#define DATABASE_URL "iigs-sp-default-rtdb.asia-southeast1.firebasedatabase.app"
#define API_KEY "AIzaSyBI0M_IbK294nLJn_SOOEngGO91e0nhdT4"

// ---------- Serial1: link to SENSOR BOARD (unchanged, pins 32/33) ----------
class SensorSystem {
  private:
    uint8_t wakePin;
    HardwareSerial* serialPort;

    void wakeAndSend(const char* cmd) {
      digitalWrite(wakePin, LOW);
      delay(200);
      digitalWrite(wakePin, HIGH);
      delay(2000);
      serialPort->println(cmd);
    }

  public:
    SensorSystem(uint8_t pin, HardwareSerial* serial) {
      wakePin = pin;
      serialPort = serial;
    }

    void begin() {
      pinMode(wakePin, OUTPUT);
      digitalWrite(wakePin, HIGH);
    }

    void requestPumpRun() {
      Serial.println("\n WATER COMMAND RECEIVED! Triggering Sensor Board...");
      wakeAndSend("W:1");
    }

    void requestSensorData() {
      Serial.println("\n-> WAKING SENSOR FOR DATA (Online Schedule)");
      wakeAndSend("W:0");
    }
};

SensorSystem sensorBoard(4, &Serial1);

// ---------- Serial2: link to CRASHHANDLER (new, pins 25/26 —
// chosen specifically to avoid 16/17, which are already wired
// elsewhere on this board) ----------
#define CRASHHANDLER_TX_PIN 25
#define CRASHHANDLER_RX_PIN 26
HardwareSerial CrashHandlerLink(2); // UART2

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

const char* ntpServer = "pool.ntp.org";
const long gmtOffset_sec = 25200;
const int daylightOffset_sec = 0;

int lastCollectionMinute = -1;
int defaultIntervalMinutes = 5;
unsigned long lastOfflineWake = 0;
unsigned long lastPollTime = 0;
unsigned long resetDelayTimer = 0;
unsigned long lastUploadAttempt = 0;
unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL_MS = 30000;

bool needsDatabaseReset = false;
int sslFailCount = 0;
int lastMotorAngle = -999;

bool pendingUpload = false;
float pendingTemp = 0.0;
float pendingHum = 0.0;
int pendingSoil = 0;

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600, SERIAL_8N1, 33, 32); // to sensor board, unchanged
  CrashHandlerLink.begin(9600, SERIAL_8N1, CRASHHANDLER_RX_PIN, CRASHHANDLER_TX_PIN); // to crashHandler

  esp_task_wdt_config_t wdt_config = {
    .timeout_ms = WDT_TIMEOUT_SEC * 1000,
    .idle_core_mask = 0,
    .trigger_panic = true
  };
  esp_task_wdt_reconfigure(&wdt_config);
  esp_task_wdt_add(NULL);

  sensorBoard.begin();

  WiFiManager wm;
  if (!wm.autoConnect("Master_Watering_System", "admin123")) {
    Serial.println("Failed to connect to Wi-Fi. Continuing offline...");
  }
  WiFi.setSleep(false);
  delay(3000);

  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
  struct tm timeinfo;
  int timeTimeout = 0;
  Serial.print("Syncing Time");
  while (!getLocalTime(&timeinfo) && timeTimeout < 15) {
    delay(1000);
    Serial.print(".");
    timeTimeout++;
  }
  Serial.println(timeTimeout >= 15 ? "\nBooted offline without NTP time." : "\nTime synced successfully!");

  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  config.timeout.wifiReconnect = 10000;
  config.timeout.socketConnection = 10000;
  config.timeout.sslHandshake = 10000;
  config.timeout.serverResponse = 10000;

  fbdo.setResponseSize(2048);
  fbdo.setBSSLBufferSize(4096, 1024);

  Firebase.signUp(&config, &auth, "", "");
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  if (WiFi.status() == WL_CONNECTED && Firebase.ready()) {
    if (Firebase.getInt(fbdo, "/sensors/control/collection_interval_mins")) {
      defaultIntervalMinutes = fbdo.intData();
      if (defaultIntervalMinutes <= 0) defaultIntervalMinutes = 5;
    }
  }

  // Tell crashHandler this board just (re)booted — it logs this as part
  // of the system's persistent crash history, even though THIS board
  // doesn't keep its own Preferences counter anymore.
  delay(500); // give crashHandler a moment to finish its own setup() first
  CrashHandlerLink.println("BOOT");
}

void loop() {
  esp_task_wdt_reset();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(" Wi-Fi lost! Attempting hardware reconnect...");
    WiFi.disconnect();
    WiFi.reconnect();
    delay(3000);
  }

  bool isOnline = (WiFi.status() == WL_CONNECTED && Firebase.ready());

  if (!isOnline && (millis() - lastOfflineWake > (defaultIntervalMinutes * 60000))) {
    lastOfflineWake = millis();
    Serial.println("System offline. Sending fallback wake signal...");
    sensorBoard.requestSensorData();
  }

  if (Serial1.available()) {
    String incoming = Serial1.readStringUntil('\n');
    incoming.trim();

    if (incoming.startsWith("D:")) {
      incoming.remove(0, 2);
      int firstComma = incoming.indexOf(',');
      int secondComma = incoming.indexOf(',', firstComma + 1);

      if (firstComma > 0 && secondComma > 0) {
        pendingTemp = incoming.substring(0, firstComma).toFloat();
        pendingHum = incoming.substring(firstComma + 1, secondComma).toFloat();
        pendingSoil = incoming.substring(secondComma + 1).toInt();
        pendingUpload = true;
      }
    }
  }

  if (!isOnline) {
    delay(100);
    return;
  }

  if (!pendingUpload && !needsDatabaseReset && (millis() - lastPollTime > 8000)) {
    lastPollTime = millis();

    if (Firebase.getJSON(fbdo, "/sensors/control")) {
      FirebaseJson &json = fbdo.jsonObject();
      FirebaseJsonData jsonData;

      json.get(jsonData, "run_pump");
      if (jsonData.success && jsonData.boolValue == true) {
        sensorBoard.requestPumpRun();
        needsDatabaseReset = true;
        resetDelayTimer = millis();
      }

      json.get(jsonData, "motor_angle");
      if (jsonData.success && jsonData.intValue != 0 && jsonData.intValue != lastMotorAngle) {
        Serial.printf("\n MOTOR COMMAND: %d degrees -> relaying to crashHandler\n", jsonData.intValue);
        CrashHandlerLink.println("MOTOR:" + String(jsonData.intValue));
        lastMotorAngle = jsonData.intValue;
        needsDatabaseReset = true;
        resetDelayTimer = millis();
      }
    } else {
      if (fbdo.httpCode() < 0) {
        fbdo.clear();
      }
    }
  }

  if (needsDatabaseReset && (millis() - resetDelayTimer > 2000)) {
    FirebaseJson resetJson;
    resetJson.set("run_pump", false);
    resetJson.set("motor_angle", 0);

    if (Firebase.updateNode(fbdo, "/sensors/control", resetJson)) {
      needsDatabaseReset = false;
      Serial.println("-> Database commands reset successfully.");
      lastMotorAngle = -999; // allow the same angle to be commanded again later
    } else {
      fbdo.clear();
    }
  }

  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    int currentMinute = timeinfo.tm_min;
    if ((currentMinute % defaultIntervalMinutes == 0) && (currentMinute != lastCollectionMinute)) {
      lastCollectionMinute = currentMinute;
      sensorBoard.requestSensorData();
    }
  }

  if (pendingUpload && (millis() - lastUploadAttempt > 2000)) {
    lastUploadAttempt = millis();
    time_t now = time(nullptr);
    Serial.println("Attempting Firebase upload...");

    FirebaseJson json;
    json.set("temperature_c", pendingTemp);
    json.set("humidity_percent", pendingHum);
    json.set("soil_moisture_percent", pendingSoil);
    json.set("timestamp", now);

    bool historySuccess = Firebase.pushJSON(fbdo, "/sensors/history", json);
    delay(100);

    if (historySuccess) {
      bool currentSuccess = Firebase.setJSON(fbdo, "/sensors/current", json);
      if (currentSuccess) {
        Serial.println("Firebase upload complete!");
        pendingUpload = false;
        sslFailCount = 0;
      }
    } else {
      sslFailCount++;
      Serial.printf("> Upload failed. Fail count: %d\n", sslFailCount);
      fbdo.clear();

      if (sslFailCount >= 3) {
        Serial.println("CRITICAL: Forcing safe reboot to clear SSL stack...");
        delay(1000);
        ESP.restart();
      }
    }
  }

  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = millis();
    time_t now = time(nullptr);
    Firebase.setInt(fbdo, "/sensors/system/last_seen", (int)now);
  }

  delay(10);
}
