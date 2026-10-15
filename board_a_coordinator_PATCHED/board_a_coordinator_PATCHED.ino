#include <WiFi.h>
#include <WiFiManager.h>
#include <FirebaseESP32.h>
#include <time.h>
#include <esp_task_wdt.h>
#include <Preferences.h>

#define WDT_TIMEOUT_SEC 90

// Wi-Fi recovery timings. See the block in setup() for why the portal must
// expire and why the stored credentials are retried afterwards.
#define WIFI_JOIN_TIMEOUT_S   20    // one join attempt before giving up
#define PORTAL_TIMEOUT_S     600    // 10 min for a person to enter new details
#define WIFI_RETRY_TIMEOUT_S  60    // then retry the SAVED network this long
#define WIFI_CHECK_MS      15000UL  // how often the link is inspected
#define WIFI_RETRY_EVERY_S    30    // radio cycled this often while down
#define WIFI_DEAD_RESTART_S  600    // down this long -> reboot the board

#define DATABASE_URL "https://iigs-sp.firebaseio.com"
#define API_KEY      "AIzaSyBI0M_IbK294nLJn_SOOEngGO91e0nhdT4"

int  cfgCollectionIntervalM = 60;
bool cfgTestMode        = true;
int  cfgSurveyIntervalH = 6;

const int SURVEY_MIN_H = 1;
const int SURVEY_MAX_H = 24;

const unsigned long TEST_CHECK_MS  = 10UL * 60UL * 1000UL;
const unsigned long TEST_SURVEY_MS = 30UL * 60UL * 1000UL;

unsigned long moistureCheckMs() {
  return cfgTestMode ? TEST_CHECK_MS
                     : (unsigned long)cfgCollectionIntervalM * 60000UL;
}

unsigned long photoSurveyMs() {
  return cfgTestMode ? TEST_SURVEY_MS
                     : (unsigned long)cfgSurveyIntervalH * 3600000UL;
}

// Polling the control node every 2 s was 1800 cloud reads an hour. On a weak
// link that is not responsiveness, it is the main source of handshake churn:
// every poll is a chance to fail, and a failure costs a backoff that delays
// real work.
//
// Raised from 15 s to 5 s because the operator is watching. Fifteen seconds
// between pressing a button and the mount moving reads as a broken control,
// not a deliberate one, and the mount panel is driven by hand. The cost is
// 720 reads an hour instead of 240: three times the chances to fail, and
// three consecutive failures start a backoff during which the scheduled
// moisture check does not run either. If the access point is poor, put this
// back to 15000.
const unsigned long CONTROL_POLL_NORMAL_MS = 30000UL;
const unsigned long CONTROL_POLL_TEST_MS   = 5000UL;

unsigned long controlPollMs() {
  return cfgTestMode ? CONTROL_POLL_TEST_MS : CONTROL_POLL_NORMAL_MS;
}

const unsigned long HEARTBEAT_MS        = 30000UL;
const unsigned long RESTART_INTERVAL_MS = 6UL * 60UL * 60UL * 1000UL;
// A restart is a KNOWN remedy for this fault: every observed dead spell ended
// with one and service resumed. Ten minutes was the time spent confirming the
// obvious. Four minutes still covers roughly nine consecutive failures, which
// is far past a blip, and halves the worst-case gap. Not shorter than this:
// a boot costs about 40 s of NTP and sign-up, and mints a new anonymous
// identity each time, so restarting on a two-minute hair trigger trades one
// gap for a different one.
const unsigned long CLOUD_DEAD_MS       = 240000UL;

// ONE, not two. A frame count of 1 makes buildSweepAngles() return a single
// angle of 0, which is home, so runSweep() computes a zero delta and never
// moves the motor. That is the routine capture: one frame, no mechanism.
// The floor must be 1 rather than 0, because a count of 0 would read
// angles[-1] when the log records the sweep's span.
const int SWEEP_FRAMES_MIN = 1;
const int SWEEP_FRAMES_MAX = 9;

int cfgRoutineFrames  = 5;
int cfgRoutineSpanDeg = 180;
int cfgCheckFrames    = 3;
int cfgCheckSpanDeg   = 90;
int cfgManualSweepSpanDeg = 90;
int cfgManualSweepFrames  = 3;
bool cfgCheckSweepEnabled = true;

const int MANUAL_STEP_DEG      = 45;
// MUST MATCH STEPPER_RPM ON BOARD B. Four is the measured value.
//
// Taken from the motor log rather than from the other source file: across 278
// completed moves at six different angles, every median duration matches 4 rpm
// to within 25 ms once Board B's 150 ms reply delay is allowed for. A 45 degree
// move measured 2060 ms against 2037 predicted; 10 rpm would have been 912.
//
// If STEPPER_RPM on Board B is ever raised, raise this with it - the check
// below compares each move against this figure and warns when one completes in
// under half the expected time, which is how a stepper silently skipping steps
// would announce itself on a mount with no encoder.
const int MOTOR_RPM            = 4;
const long MOTOR_STEPS_PER_REV = 2048;

#define ENABLE_MANUAL_BUTTON_CAPTURE 0

const unsigned long CAPTURE_TIMEOUT_MS = 30000UL;

const int THRESHOLD_MIN_PCT = 10;
const int THRESHOLD_MAX_PCT = 80;
const int PUMP_MIN_SEC      = 1;
const int PUMP_MAX_SEC      = 30;
const int COOLDOWN_MIN_H    = 1;
const int COOLDOWN_MAX_H    = 48;
const int FAILSAFE_MIN_H    = 1;
const int FAILSAFE_MAX_H    = 48;
// Lowered from 60 for the measurement window. A drying segment needs four
// readings across three hours to qualify at all, so hourly sampling sits
// exactly on the minimum and a single missed reading destroys the segment.
// Thirty minutes doubles the margin without doubling TLS traffic, which is
// where the earlier failures lived.
const int HISTORY_MIN_MIN   = 30;
const int HISTORY_MAX_MIN   = 1440;
const int TEMP_MIN_LIMIT    = -10;
const int TEMP_MAX_LIMIT    = 60;
const int NOTIFY_MIN_H      = 1;
const int NOTIFY_MAX_H      = 24;

// Zero is a legitimate span: every frame at home. With a frame count above 1
// that is a burst from one viewpoint; with a count of 1 the span is moot.
const int ALLOWED_SPANS[]    = { 0, 90, 180, 360 };
const int ALLOWED_SPAN_COUNT = 4;

#define WAKE_PIN            4

// Board A GPIO -> Board C EN (reset) pin.
//
// WIRING NOTE, and it matters: EN carries an internal pull-up and a capacitor
// to ground on every dev board. This pin is therefore held as INPUT at all
// times and only switched to OUTPUT LOW for the length of the reset pulse,
// then released back to INPUT. It is never driven HIGH. Driving HIGH fights
// the pull-up, injects current into the capacitor, and on some boards holds
// the target out of reset permanently.
#define SENSOR_RESET_PIN    13
#define CRASHHANDLER_TX_PIN 25
#define CRASHHANDLER_RX_PIN 26

HardwareSerial MotorLink(2);

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

const char* ntpServer = "pool.ntp.org";
const long  gmtOffset_sec = 25200;
const int   daylightOffset_sec = 0;

int  cfgThresholdPct        = 60;
bool cfgAutoWaterEnabled    = true;
bool cfgDataCollectEnabled  = true;
int  cfgFailsafeHours       = 6;
int  cfgPumpSeconds         = 5;
int  cfgMinWaterHours       = 6;

bool cfgNotifyWatered       = true;
bool cfgNotifySensorFail    = true;
bool cfgNotifySoilLow       = true;
bool cfgNotifyTempRange     = true;
bool cfgNotifyCaptureFail   = false;
int  cfgNotifyIntervalHours = 4;
int  cfgTempMinC            = 15;
int  cfgTempMaxC            = 35;

bool cfgNotifyReservoir     = true;
int  cfgReservoirLowPct     = 20;
int  cfgReservoirEmptyPct   = 5;
// OFF by default, deliberately. Refusing to water on a reservoir reading is a
// decision with teeth: a miscalibrated or failed level sensor would stop the
// plant being watered at all, and a sensor that has already failed once in
// service is not something to make watering depend on without being asked.
bool cfgBlockWaterWhenEmpty = false;

time_t lastNotifySoilLow   = 0;
time_t lastNotifyTempRange = 0;
time_t lastNotifyReservoir = 0;

// LATCHES, so a condition announces itself once and announces its end once.
//
// Without these a persisting fault reposts every notification interval and
// nothing marks recovery, so the feed becomes a wall of identical warnings
// that never resolves - the same mistake the sensor escalation ladder was
// built to avoid. A warning that cannot clear is noise, not information.
bool soilLowActive      = false;
bool tempOutActive      = false;

// A LEVEL, not a flag: 0 none, 1 low, 2 empty.
//
// A boolean latch here suppressed its own escalation. Once "low" had been
// announced the latch was set, so when the level fell on through to empty the
// critical notification waited out the repeat interval behind a warning that
// was already stale. A worsening condition has to pre-empt the throttle; only
// an unchanged one should be held back.
int reservoirState = 0;

unsigned long lastMoistureCheck = 0;
unsigned long lastPhotoSurvey   = 0;
unsigned long lastControlPoll   = 0;
unsigned long lastHeartbeat     = 0;
unsigned long lastCloudSuccess  = 0;

int  checksSinceCollection = 0;
time_t lastWateredEpoch    = 0;

// Sensor-board recovery state. consecutiveSensorFailures counts checks that
// got no reply; sensorResetsIssued counts hard resets attempted since the
// last successful reply. Both clear on any good reading.
int  consecutiveSensorFailures = 0;
int  sensorResetsIssued        = 0;
bool sensorUnrecoverableSent   = false;
const int SENSOR_FAILS_BEFORE_RESET = 3;   // ~30 min at the 10-min test cadence
const int SENSOR_RESETS_BEFORE_GIVEUP = 3;

int    consecutiveCloudFailures = 0;
unsigned long cloudBackoffUntil = 0;

bool lightCommandedOn = false;
// Persisted to NVS on every change. Without that, the 6-hour scheduled
// restart returned this to 0 and Board A believed the mount was at home
// whichever way it was actually pointing - and the idle-home timer below,
// which only acts when the angle is non-zero, would never fire to correct it.
int  motorPositionDeg = 0;
unsigned long lastMotorMove = 0;
int  cfgIdleHomeMinutes = 20;      // 0 disables the return to home

const int ROUTINE_SETS = 10;
int  routineSetIndex   = 0;

const char*   currentActivity = "idle";
unsigned long activityBegan   = 0;

void feedWdt() { esp_task_wdt_reset(); }

void saveMotorPosition();          // defined with the queue, which owns the store

// Defined below; the queue needs it and sits above it.
void noteCloudResult(bool ok);
bool cloudPaused();

// ------------------------------------------------------------ reservoir ----
// The ultrasonic module measures the GAP from its own face down to the water
// surface. The gap is SMALL when the bin is full and LARGE when it is empty,
// so the mapping to a percentage is inverted. Both ends are MEASURED, not
// calculated, and they are set from the portal because they change the moment
// the mounting bracket moves.
//
// The raw gap is written to history alongside the percentage. That is
// deliberate: a mistaken calibration can then be corrected and every past
// record recomputed, instead of having silently destroyed the measurement.
const int RES_GAP_MIN_MM  = 30;     // hard floor; the HC-SR04 dead zone is ~20
const int RES_GAP_MAX_MM  = 1000;
const int RES_SPAN_MIN_MM = 20;     // a smaller span makes the percentage noise

int cfgResGapEmptyMm = 143;
int cfgResGapFullMm  = 50;

// Returns -1 when there was no echo. Never 0: an overfilled bin puts the water
// surface inside the sensor's dead zone, where it reports nothing at all.
// Mapping that to 0 % would announce an empty reservoir at the exact moment it
// is overflowing, and then ask for a refill.
int reservoirPercent(int gapMm) {
  if (gapMm <= 0) return -1;
  int span = cfgResGapEmptyMm - cfgResGapFullMm;
  if (span <= 0) return -1;
  int pct = (cfgResGapEmptyMm - gapMm) * 100 / span;
  if (pct < 0)   pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

// ---------------------------------------------------------------- queue ----
// A reading that cannot be uploaded used to be discarded. Over a month that
// cost roughly two thirds of the record and left the analysis with gaps it
// could not bridge. Readings now go to non-volatile storage when the upload
// fails and are flushed, oldest first, once the cloud answers again. Each
// record carries the timestamp of the moment it was TAKEN, so a late arrival
// is a delayed write rather than a wrong one.
//
// 96 slots is four days at hourly collection. Beyond that the oldest entry is
// overwritten, which is the correct loss: recent readings matter more, and the
// alternative is refusing to record anything at all.

Preferences qstore;
const int QUEUE_MAX = 96;
int qHead = 0;     // index of the oldest unsent record
int qCount = 0;    // how many are waiting

void queueInit() {
  qstore.begin("histq", false);
  qHead  = qstore.getInt("head", 0);
  qCount = qstore.getInt("count", 0);
  if (qHead < 0 || qHead >= QUEUE_MAX) qHead = 0;
  if (qCount < 0 || qCount > QUEUE_MAX) qCount = 0;
  Serial.printf("[QUEUE] %d reading(s) held from a previous session\n", qCount);
}

void queueSaveMeta() {
  qstore.putInt("head", qHead);
  qstore.putInt("count", qCount);
}

// Shares the queue's Preferences handle, which is open for the life of the
// board. Written only when the angle actually changes, so the flash sees a
// handful of writes a day rather than one per loop.
void saveMotorPosition() {
  qstore.putInt("motorpos", motorPositionDeg);
}

void queuePush(float t, float h, int soil, long ts,
               int freeHeap, int maxAlloc, int uptimeS,
               int rangeMm, int lightRaw) {
  int slot = (qHead + qCount) % QUEUE_MAX;
  if (qCount == QUEUE_MAX) {           // full: drop the oldest
    qHead = (qHead + 1) % QUEUE_MAX;
    slot = (qHead + qCount - 1) % QUEUE_MAX;
    Serial.println("[QUEUE] full - the oldest held reading was dropped");
  } else {
    qCount++;
  }

  char key[8];
  snprintf(key, sizeof(key), "q%d", slot);
  char rec[128];
  snprintf(rec, sizeof(rec), "%.1f,%.1f,%d,%ld,%d,%d,%d,%d,%d",
           t, h, soil, ts, freeHeap, maxAlloc, uptimeS, rangeMm, lightRaw);
  qstore.putString(key, rec);
  queueSaveMeta();
  Serial.printf("[QUEUE] reading held (%d waiting): %s\n", qCount, rec);
}

// ---------------------------------------------------------------------------
// WATERING COOLDOWN PERSISTENCE
//
// lastWateredEpoch used to live only in RAM. It was written to Firebase but
// never read back, so every reset returned it to 0 and the cooldown test
// "lastWateredEpoch == 0" passed immediately. On 23 Sep this board reset
// sixteen times in one day while the soil probe was reading 0 %, and the
// result was fourteen waterings in five hours straight through a two-hour
// cooldown. The cooldown was not too short; it was being forgotten.
//
// NVS, not Firebase, is the store of record: the cooldown has to hold when
// the network is down, which is exactly when resets are most likely. The
// Firebase value is read once as a secondary source and the later of the two
// wins, so a board whose NVS was erased still inherits the real history.
// ---------------------------------------------------------------------------
void noteWatered(time_t when) {
  lastWateredEpoch = when;
  qstore.putLong("lastwater", (long)when);
  if (Firebase.ready()) {
    Firebase.setInt(fbdo, "/sensors/system/last_watered_timestamp", (int)when);
  }
  Serial.printf("[COOLDOWN] last watering recorded at %ld (persisted)\n", (long)when);
}

void restoreLastWatered() {
  time_t fromNvs = (time_t)qstore.getLong("lastwater", 0);
  time_t fromCloud = 0;
  if (Firebase.ready() &&
      Firebase.getInt(fbdo, "/sensors/system/last_watered_timestamp")) {
    fromCloud = (time_t)fbdo.intData();
  }

  lastWateredEpoch = (fromNvs > fromCloud) ? fromNvs : fromCloud;

  // A clock that never synced reports 1970. Trusting a stored epoch against
  // it would make every elapsed time astronomically large and clear the
  // cooldown anyway, so refuse to compare and wait for the next boot.
  time_t now = time(nullptr);
  if (now < 1700000000L) {
    Serial.println("[COOLDOWN] clock not synced - holding watering until it is");
    lastWateredEpoch = now;           // forces the cooldown to block, not pass
  } else if (lastWateredEpoch > 0) {
    Serial.printf("[COOLDOWN] restored: last watering %ld s ago (nvs=%ld cloud=%ld)\n",
                  (long)(now - lastWateredEpoch), (long)fromNvs, (long)fromCloud);
  } else {
    Serial.println("[COOLDOWN] no previous watering on record");
  }
  feedWdt();
}

// Sends the oldest held reading. One per call, so a long backlog drains
// across loop iterations instead of blocking in a single burst.
bool queueFlushOne() {
  if (qCount <= 0) return false;

  char key[8];
  snprintf(key, sizeof(key), "q%d", qHead);
  String rec = qstore.getString(key, "");
  if (rec.length() < 5) {              // unreadable: drop it rather than stall
    qHead = (qHead + 1) % QUEUE_MAX; qCount--; queueSaveMeta();
    return false;
  }

  float t = 0, h = 0; int soil = 0, fh = 0, ma = 0, up = 0; long ts = 0;
  int rangeMm = -1, lightRaw = -1;

  // SEVEN OR NINE, both accepted. Records written before the reservoir and
  // light fields existed are already sitting in flash, and rejecting them
  // here would discard readings the sensors had already paid for.
  int nf = sscanf(rec.c_str(), "%f,%f,%d,%ld,%d,%d,%d,%d,%d",
                  &t, &h, &soil, &ts, &fh, &ma, &up, &rangeMm, &lightRaw);
  if (nf != 7 && nf != 9) {
    qHead = (qHead + 1) % QUEUE_MAX; qCount--; queueSaveMeta();
    return false;
  }
  if (nf == 7) { rangeMm = -1; lightRaw = -1; }   // an old-format record

  FirebaseJson j;
  j.set("temperature_c", t);
  j.set("humidity_percent", h);
  j.set("soil_moisture_percent", soil);
  j.set("timestamp", (int)ts);
  j.set("free_heap", fh);
  j.set("max_alloc_heap", ma);
  j.set("uptime_s", up);
  if (rangeMm >= 0) {
    j.set("reservoir_gap_mm", rangeMm);
    int resPct = reservoirPercent(rangeMm);
    if (resPct >= 0) j.set("reservoir_percent", resPct);
  }
  if (lightRaw >= 0 && lightRaw <= 4095) j.set("light_raw", lightRaw);
  j.set("deferred", true);             // visible in the record, not hidden

  feedWdt();
  bool ok = Firebase.pushJSON(fbdo, "/sensors/history", j);
  feedWdt();
  noteCloudResult(ok);

  if (ok) {
    qHead = (qHead + 1) % QUEUE_MAX;
    qCount--;
    queueSaveMeta();
    Serial.printf("[QUEUE] held reading sent, %d still waiting\n", qCount);
  }
  return ok;
}

void runMoistureCheck(bool manualTrigger);
void runCheckSweep();
void runPhotoSurvey();
void runManualSweep(int spanDeg, int frames);

int clampCfg(const char* name, int value, int lo, int hi) {
  if (value < lo) {
    Serial.printf("[CFG] %s was %d, raised to the minimum of %d\n", name, value, lo);
    return lo;
  }
  if (value > hi) {
    Serial.printf("[CFG] %s was %d, lowered to the maximum of %d\n", name, value, hi);
    return hi;
  }
  return value;
}

int nearestAllowedSpan(const char* name, int wanted, int fallback) {
  for (int i = 0; i < ALLOWED_SPAN_COUNT; i++) {
    if (ALLOWED_SPANS[i] == wanted) return wanted;
  }
  Serial.printf("[CFG] %s of %d is not one of 90, 180 or 360 - keeping %d\n",
                name, wanted, fallback);
  return fallback;
}

String awaitSensorLine(unsigned long timeoutMs) {
  unsigned long start = millis();
  String line = "";
  while (millis() - start < timeoutMs) {
    while (Serial1.available()) {
      char c = Serial1.read();
      if (c == '\n') { line.trim(); return line; }
      if (c != '\r') line += c;
    }
    feedWdt();
    delay(10);
  }
  line.trim();
  return line;
}

String awaitMotorLine(unsigned long timeoutMs) {
  unsigned long start = millis();
  String line = "";
  while (millis() - start < timeoutMs) {
    while (MotorLink.available()) {
      char c = MotorLink.read();
      if (c == '\n') { line.trim(); return line; }
      if (c != '\r') line += c;
    }
    feedWdt();
    delay(10);
  }
  line.trim();
  return line;
}

// Hard-resets Board C by pulling its EN line low. See the SENSOR_RESET_PIN
// comment for why the pin is held as INPUT between pulses and never driven
// HIGH. Returns after the target has had time to boot and announce itself.
void resetSensorBoard() {
  sensorResetsIssued++;
  Serial.printf("[RECOVER] pulsing Board C reset (attempt %d of %d)\n",
                sensorResetsIssued, SENSOR_RESETS_BEFORE_GIVEUP);

  pinMode(SENSOR_RESET_PIN, OUTPUT);
  digitalWrite(SENSOR_RESET_PIN, LOW);
  delay(200);
  pinMode(SENSOR_RESET_PIN, INPUT);      // release; the pull-up restores EN

  // An ESP32 takes roughly 300 ms to reach setup(), and Board C sends its
  // ready line immediately after Serial1.begin(). Allow generous margin, and
  // feed the watchdog across the wait rather than blocking through it.
  for (int i = 0; i < 20; i++) { delay(100); feedWdt(); }

  Serial.println("[RECOVER] reset released");
}

// ---------------------------------------------------------------------------
// WI-FI LINK MAINTENANCE
//
// Nothing was watching the radio. The only recovery path was the cloud
// watchdog ("nothing has succeeded for 10 minutes"), which restarts the board
// — but that cannot help when the fault is a layer below it, and it only acts
// on the Firebase client's opinion of the world.
//
// On 2 Oct the board panicked inside Firebase.signUp() and rebooted via
// abort(). A panic reset (rst:0xc SW_CPU_RESET) does not bring the radio up
// the way a power-on does, and the stack came back in a state where the join
// silently never completed:
//
//   *wm:AutoConnect: FAILED for  58393 ms
//
// The password was never wrong. The saved network was correct and had worked
// minutes earlier. The radio simply needed to be cycled, and nothing was
// there to do it.
//
// So: inspect the link every 15 s, and while it is down, turn the radio off
// and on again before each retry. WiFi.begin() with no arguments reuses the
// credentials already in flash, so this never touches the portal. If the link
// stays down for ten minutes the board restarts, which is the last resort
// rather than the first one.
// ---------------------------------------------------------------------------
void maintainWifi() {
  static unsigned long lastCheck = 0;
  static unsigned long downSince = 0;
  static unsigned long lastRetry = 0;

  if (millis() - lastCheck < WIFI_CHECK_MS) return;
  lastCheck = millis();

  if (WiFi.status() == WL_CONNECTED) {
    if (downSince) {
      Serial.printf("[WIFI] link restored after %lu s, IP %s\n",
                    (millis() - downSince) / 1000UL,
                    WiFi.localIP().toString().c_str());
      downSince = 0;
    }
    return;
  }

  if (downSince == 0) {
    downSince = millis();
    lastRetry = 0;
    Serial.println("[WIFI] link down");
  }

  unsigned long downFor = (millis() - downSince) / 1000UL;

  if (downFor >= (unsigned long)WIFI_DEAD_RESTART_S) {
    Serial.printf("[WIFI] down %lu s - restarting the board\n", downFor);
    delay(100);
    ESP.restart();
  }

  if (lastRetry && millis() - lastRetry < (unsigned long)WIFI_RETRY_EVERY_S * 1000UL) return;
  lastRetry = millis();

  // Off, pause, on. Simply calling begin() again on a stack that has failed
  // this way does nothing at all.
  Serial.printf("[WIFI] down %lu s - cycling the radio and retrying the saved network\n",
                downFor);
  WiFi.disconnect(false, false);     // never erase the stored credentials
  WiFi.mode(WIFI_OFF);
  delay(200);
  feedWdt();
  WiFi.mode(WIFI_STA);
  WiFi.begin();                      // stored SSID and password, no portal
  feedWdt();
}

bool wakeSensorBoard() {
  while (Serial1.available()) Serial1.read();

  unsigned long began = millis();
  digitalWrite(WAKE_PIN, HIGH);
  delay(200);
  digitalWrite(WAKE_PIN, LOW);

  unsigned long deadline = millis() + 3000UL;
  while (millis() < deadline) {
    String line = awaitSensorLine(500);
    if (line.length()) {
      if (line.indexOf('R') >= 0) {
        Serial.printf("[WAKE] sensor board ready after %lu ms\n", millis() - began);
        return true;
      }
      Serial.println("[WAKE] ignoring: " + line);
    }
    feedWdt();
  }

  Serial.println("[WAKE] no ready signal - falling back to a fixed wait");
  delay(1500);
  return false;
}

void pushConfigToSensorBoard() {
  Serial1.printf("C:%d,%d,%d,%ld\n",
                 cfgThresholdPct, cfgFailsafeHours, cfgPumpSeconds,
                 (long)time(nullptr));
  Serial.printf("[TX->C] C:%d,%d,%d\n", cfgThresholdPct, cfgFailsafeHours, cfgPumpSeconds);
  delay(200);
}

void noteCloudResult(bool ok) {
  if (ok) {
    if (consecutiveCloudFailures > 0) {
      Serial.printf("[CLOUD] recovered after %d failures\n", consecutiveCloudFailures);
    }
    consecutiveCloudFailures = 0;
    cloudBackoffUntil = 0;
    lastCloudSuccess = millis();
    return;
  }

  consecutiveCloudFailures++;
  if (consecutiveCloudFailures < 3) return;

  // Cap lowered from 60 s to 20 s. The failure is transport-level, not a rate
  // limit: the heap evidence shows the board is handed memory BACK when the
  // session dies, so there is nothing to let drain. A 60 s cap meant the board
  // sat idle through most of the outage and caught the recovery late. Twenty
  // seconds triples the number of attempts inside the same dead spell without
  // becoming a hammer.
  unsigned long wait = 2000UL << (consecutiveCloudFailures - 3);
  if (wait > 20000UL || wait == 0) wait = 20000UL;

  cloudBackoffUntil = millis() + wait;
  Serial.printf("[CLOUD] %d consecutive failures, pausing %lu s\n",
                consecutiveCloudFailures, wait / 1000UL);

  fbdo.clear();
}

bool cloudPaused() {
  if (cloudBackoffUntil == 0) return false;
  if (millis() >= cloudBackoffUntil) { cloudBackoffUntil = 0; return false; }
  return true;
}

bool cloudHealthy() {
  return Firebase.ready() && !cloudPaused() && consecutiveCloudFailures == 0;
}

bool cameraReachable() {
  return Firebase.ready() && !cloudPaused();
}

void setActivity(const char* what, const char* detail) {
  currentActivity = what;
  activityBegan = millis();
  Serial.printf("[BUSY] %s: %s\n", what, detail);
  if (!cloudHealthy()) return;
  FirebaseJson j;
  j.set("activity", what);
  j.set("activity_detail", detail);
  j.set("activity_since", (int)time(nullptr));
  Firebase.updateNode(fbdo, "/sensors/system", j);
  feedWdt();
}

void setActivityDetail(const char* detail) {
  if (!cloudHealthy()) return;
  Firebase.setString(fbdo, "/sensors/system/activity_detail", detail);
  feedWdt();
}

void clearActivity(const char* outcome) {
  unsigned long took = millis() - activityBegan;
  const char* was = currentActivity;
  currentActivity = "idle";
  if (activityBegan > 0) {
    Serial.printf("[BUSY] %s finished after %lu ms: %s\n", was, took, outcome);
  }
  activityBegan = 0;
  if (!cloudHealthy()) return;
  FirebaseJson j;
  j.set("activity", "idle");
  j.set("activity_detail", "");
  j.set("last_activity", was);
  j.set("last_outcome", outcome);
  j.set("last_activity_took_ms", (int)took);
  j.set("last_activity_at", (int)time(nullptr));
  Firebase.updateNode(fbdo, "/sensors/system", j);
  feedWdt();
}

bool clearCommand(const char* path) {
  if (Firebase.setBool(fbdo, path, false)) return true;
  Serial.printf("[CTL] could not clear %s - leaving it for the next poll\n", path);
  return false;
}

void clearStaleCommands() {
  if (!Firebase.ready()) return;

  FirebaseJson clear;
  clear.set("run_pump", false);
  clear.set("run_automation_check", false);
  clear.set("run_sweep", false);
  clear.set("run_manual_sweep", false);
  clear.set("capture_requested", false);
  clear.set("motor_angle", 0);

  if (Firebase.updateNode(fbdo, "/sensors/control", clear)) {
    Serial.println("[CTL] cleared any command left set from before this restart");
  } else {
    Serial.println("[CTL] could not clear stale commands - some may run shortly");
  }
  feedWdt();
}

void buildSweepAngles(int *angles, int count, int spanDeg) {
  if (count < 2) { angles[0] = 0; return; }
  int start = -(spanDeg / 2);
  for (int i = 0; i < count; i++) {
    angles[i] = start + (spanDeg * i) / (count - 1);
  }
}

void fetchConfig() {
  if (!Firebase.ready()) {
    Serial.println("[CFG] skipped - Firebase not ready");
    return;
  }
  bool cfgOk = Firebase.getJSON(fbdo, "/sensors/config");
  noteCloudResult(cfgOk);
  if (!cfgOk) {
    Serial.println("[CFG] READ FAILED: " + fbdo.errorReason());
    feedWdt();
    return;
  }

  int  vThresh = cfgThresholdPct,   vPump = cfgPumpSeconds;
  int  vCool = cfgMinWaterHours,    vFail = cfgFailsafeHours;
  int  vHist = cfgCollectionIntervalM;
  int  vResEmpty = cfgResGapEmptyMm, vResFull = cfgResGapFullMm;
  int  vIdleHome = cfgIdleHomeMinutes;
  int  vRSpan = cfgRoutineSpanDeg,  vCSpan = cfgCheckSpanDeg;
  int  vRFrames = cfgRoutineFrames, vCFrames = cfgCheckFrames;
  int  vTMin = cfgTempMinC,         vTMax = cfgTempMaxC;
  int  vNotifyH = cfgNotifyIntervalHours;
  int  vSurvey = cfgSurveyIntervalH;
  bool vTest = cfgTestMode;
  bool vAuto = cfgAutoWaterEnabled, vCollect = cfgDataCollectEnabled;
  bool vCheckSweep = cfgCheckSweepEnabled;
  bool nWater = cfgNotifyWatered,   nSensor = cfgNotifySensorFail;
  bool nSoil = cfgNotifySoilLow,    nTemp = cfgNotifyTempRange;
  bool nRes  = cfgNotifyReservoir;
  int  vResLowPct = cfgReservoirLowPct, vResEmptyPct = cfgReservoirEmptyPct;
  bool vBlock  = cfgBlockWaterWhenEmpty;
  bool nCap = cfgNotifyCaptureFail;

  {
    FirebaseJson &j = fbdo.jsonObject();
    FirebaseJsonData d;

    j.get(d, "moisture_threshold_percent"); if (d.success && d.intValue > 0) vThresh = d.intValue;
    j.get(d, "auto_water_enabled");         if (d.success) vAuto    = d.boolValue;
    j.get(d, "data_collection_enabled");    if (d.success) vCollect = d.boolValue;
    j.get(d, "collection_interval_mins");   if (d.success && d.intValue > 0) vHist  = d.intValue;
    j.get(d, "failsafe_timeout_hours");     if (d.success && d.intValue > 0) vFail  = d.intValue;
    j.get(d, "pump_run_seconds");           if (d.success && d.intValue > 0) vPump  = d.intValue;
    j.get(d, "min_water_interval_hours");   if (d.success && d.intValue > 0) vCool  = d.intValue;
    j.get(d, "sweep/routine_span_deg");     if (d.success && d.intValue > 0) vRSpan = d.intValue;
    j.get(d, "sweep/check_span_deg");       if (d.success && d.intValue > 0) vCSpan = d.intValue;
    j.get(d, "sweep/check_sweep_enabled");  if (d.success) vCheckSweep = d.boolValue;
    j.get(d, "camera/idle_home_minutes");   if (d.success) vIdleHome = d.intValue;
    j.get(d, "sweep/routine_frames");       if (d.success && d.intValue > 0) vRFrames = d.intValue;
    j.get(d, "sweep/check_frames");         if (d.success && d.intValue > 0) vCFrames = d.intValue;
    j.get(d, "reservoir/gap_empty_mm");     if (d.success && d.intValue > 0) vResEmpty = d.intValue;
    j.get(d, "reservoir/gap_full_mm");      if (d.success && d.intValue > 0) vResFull  = d.intValue;
    j.get(d, "temp_min_c");                 if (d.success) vTMin = d.intValue;
    j.get(d, "temp_max_c");                 if (d.success) vTMax = d.intValue;
    j.get(d, "notifications/watered");            if (d.success) nWater  = d.boolValue;
    j.get(d, "notifications/sensor_no_response"); if (d.success) nSensor = d.boolValue;
    j.get(d, "notifications/soil_low");           if (d.success) nSoil   = d.boolValue;
    j.get(d, "notifications/temp_out_of_range");  if (d.success) nTemp   = d.boolValue;
    j.get(d, "notifications/capture_failed");     if (d.success) nCap    = d.boolValue;
    j.get(d, "notifications/reservoir_low");      if (d.success) nRes    = d.boolValue;
    j.get(d, "reservoir/low_percent");            if (d.success) vResLowPct   = d.intValue;
    j.get(d, "reservoir/empty_percent");          if (d.success) vResEmptyPct = d.intValue;
    j.get(d, "reservoir/block_water_when_empty"); if (d.success) vBlock    = d.boolValue;
    j.get(d, "notifications/interval_hours");     if (d.success && d.intValue > 0) vNotifyH = d.intValue;
  j.get(d, "survey_interval_hours");            if (d.success && d.intValue > 0) vSurvey  = d.intValue;
  j.get(d, "test_mode");                        if (d.success) vTest = d.boolValue;
  }

  cfgThresholdPct        = clampCfg("threshold", vThresh, THRESHOLD_MIN_PCT, THRESHOLD_MAX_PCT);
  cfgPumpSeconds         = clampCfg("pump duration", vPump, PUMP_MIN_SEC, PUMP_MAX_SEC);
  cfgMinWaterHours       = clampCfg("watering cooldown", vCool, COOLDOWN_MIN_H, COOLDOWN_MAX_H);
  cfgFailsafeHours       = clampCfg("failsafe timeout", vFail, FAILSAFE_MIN_H, FAILSAFE_MAX_H);
  cfgCollectionIntervalM = clampCfg("history interval", vHist, HISTORY_MIN_MIN, HISTORY_MAX_MIN);
  cfgRoutineFrames       = clampCfg("routine frames", vRFrames, SWEEP_FRAMES_MIN, SWEEP_FRAMES_MAX);
  cfgCheckFrames         = clampCfg("check frames", vCFrames, SWEEP_FRAMES_MIN, SWEEP_FRAMES_MAX);
  cfgNotifyIntervalHours = clampCfg("notification interval", vNotifyH, NOTIFY_MIN_H, NOTIFY_MAX_H);
  cfgTempMinC            = clampCfg("temp min", vTMin, TEMP_MIN_LIMIT, TEMP_MAX_LIMIT);
  cfgTempMaxC            = clampCfg("temp max", vTMax, TEMP_MIN_LIMIT, TEMP_MAX_LIMIT);
  cfgRoutineSpanDeg      = nearestAllowedSpan("routine span", vRSpan, cfgRoutineSpanDeg);
  cfgCheckSpanDeg        = nearestAllowedSpan("check span", vCSpan, cfgCheckSpanDeg);
  cfgIdleHomeMinutes     = clampCfg("idle home", vIdleHome, 0, 240);
  cfgSurveyIntervalH     = clampCfg("survey interval", vSurvey, SURVEY_MIN_H, SURVEY_MAX_H);

  // REJECTED, NOT SWAPPED, and deliberately unlike the temperature range
  // below. An inverted temperature limit is a typo whose intent is obvious.
  // An inverted reservoir calibration means someone mismeasured, and guessing
  // their intent would quietly produce a wrong percentage on every record
  // from here on. Keep the last known-good pair and say so loudly.
  {
    int cEmpty = clampCfg("reservoir empty gap", vResEmpty, RES_GAP_MIN_MM, RES_GAP_MAX_MM);
    int cFull  = clampCfg("reservoir full gap",  vResFull,  RES_GAP_MIN_MM, RES_GAP_MAX_MM);
    if (cEmpty - cFull >= RES_SPAN_MIN_MM) {
      cfgResGapEmptyMm = cEmpty;
      cfgResGapFullMm  = cFull;
    } else {
      Serial.printf("[CFG] reservoir calibration rejected: empty %d mm must exceed "
                    "full %d mm by at least %d mm - keeping %d/%d\n",
                    cEmpty, cFull, RES_SPAN_MIN_MM,
                    cfgResGapEmptyMm, cfgResGapFullMm);
    }
  }

  cfgAutoWaterEnabled    = vAuto;
  cfgDataCollectEnabled  = vCollect;
  cfgCheckSweepEnabled   = vCheckSweep;
  cfgNotifyWatered       = nWater;
  cfgNotifySensorFail    = nSensor;
  cfgNotifySoilLow       = nSoil;
  cfgNotifyTempRange     = nTemp;
  cfgNotifyReservoir     = nRes;
  cfgBlockWaterWhenEmpty = vBlock;
  cfgReservoirEmptyPct   = clampCfg("reservoir empty", vResEmptyPct, 0, 50);
  cfgReservoirLowPct     = clampCfg("reservoir low", vResLowPct, 1, 90);
  if (cfgReservoirLowPct <= cfgReservoirEmptyPct) {
    // Low must sit above empty or the warning never fires before the critical
    // one and the operator gets no notice at all.
    cfgReservoirLowPct = cfgReservoirEmptyPct + 1;
    Serial.printf("[CFG] reservoir low raised to %d%% to stay above empty at %d%%\n",
                  cfgReservoirLowPct, cfgReservoirEmptyPct);
  }
  cfgNotifyCaptureFail   = nCap;

  if (vTest != cfgTestMode) {
    cfgTestMode = vTest;
    Serial.printf("[MODE] switched to %s: check every %lu min, survey every %lu min\n",
                  cfgTestMode ? "TEST" : "NORMAL",
                  moistureCheckMs() / 60000UL, photoSurveyMs() / 60000UL);
  }

  if (cfgTempMinC >= cfgTempMaxC) {
    Serial.printf("[CFG] temperature range %d to %d is inverted - swapping\n",
                  cfgTempMinC, cfgTempMaxC);
    int t = cfgTempMinC; cfgTempMinC = cfgTempMaxC; cfgTempMaxC = t;
    if (cfgTempMinC == cfgTempMaxC) cfgTempMaxC = cfgTempMinC + 1;
  }

  Serial.printf("[CFG] read: threshold=%d%% pump=%ds cooldown=%dh "
                "failsafe=%dh history=%dmin routine=%dx%ddeg check=%dx%ddeg%s\n",
                cfgThresholdPct, cfgPumpSeconds, cfgMinWaterHours,
                cfgFailsafeHours, cfgCollectionIntervalM,
                cfgRoutineFrames, cfgRoutineSpanDeg,
                cfgCheckFrames, cfgCheckSpanDeg,
                cfgCheckSweepEnabled ? "" : " (check sweep off)");
  Serial.printf("[CFG] mode=%s check every %lu min, survey every %lu min\n",
                cfgTestMode ? "TEST" : "NORMAL",
                moistureCheckMs() / 60000UL, photoSurveyMs() / 60000UL);
  feedWdt();
}

void writeAutomationLog(char collected, char pump, char flag, int soil, const char* source) {
  char stages[4] = { collected, pump, flag, '\0' };

  // The decision is always printed. It is only pushed when the link is up:
  // the check now runs during an outage, and a push against a dead socket
  // blocks for the SSL handshake timeout on every call. The reading itself is
  // preserved by the NVS queue; the decision log is the expendable half.
  if (cloudPaused()) {
    Serial.printf("[LOG] %s soil=%d%% src=%s (cloud paused, not pushed)\n",
                  stages, soil, source);
    return;
  }

  FirebaseJson j;
  j.set("timestamp", (int)time(nullptr));
  j.set("stages", stages);
  j.set("soil_moisture_percent", soil);
  j.set("source", source);
  noteCloudResult(Firebase.pushJSON(fbdo, "/sensors/automation_log", j));
  Serial.printf("[LOG] %s soil=%d%% src=%s\n", stages, soil, source);
  feedWdt();
}

void pushNotification(const char* type, const char* severity,
                      const char* message, int value, bool enabled) {
  if (!enabled) return;
  if (!Firebase.ready()) return;

  FirebaseJson j;
  j.set("timestamp", (int)time(nullptr));
  j.set("type", type);
  j.set("severity", severity);
  j.set("message", message);
  if (value != INT32_MIN) j.set("value", value);

  Firebase.pushJSON(fbdo, "/sensors/notifications", j);
  Serial.printf("[NOTIFY] %s (%s): %s\n", type, severity, message);
  feedWdt();
}

bool notifyDue(time_t *last) {
  time_t now = time(nullptr);
  if (*last != 0 && (now - *last) < (time_t)cfgNotifyIntervalHours * 3600) return false;
  *last = now;
  return true;
}

void writeMotorLog(int angle, bool ok, unsigned long tookMs) {
  FirebaseJson j;
  j.set("timestamp", (int)time(nullptr));
  j.set("angle_deg", angle);
  j.set("result", ok ? "ok" : "fail");
  j.set("position_after_deg", motorPositionDeg);
  j.set("took_ms", (int)tookMs);
  Firebase.pushJSON(fbdo, "/sensors/motor_log", j);
  feedWdt();
}

bool commandPumpAndAwaitResult() {
  Serial1.println("W:1");
  Serial.println("[TX->C] W:1");

  String result = "";
  unsigned long deadline = millis() + (unsigned long)(cfgPumpSeconds + 10) * 1000UL;
  while (millis() < deadline) {
    String line = awaitSensorLine(2000);
    if (line.length()) {
      Serial.println("[RX<-C] " + line);
      int at = line.indexOf("P:");
      if (at >= 0) { result = line.substring(at); break; }
    }
    feedWdt();
  }

  if (result.length() == 0) Serial.println("[WARN] no pump result from Board C");
  return result.startsWith("P:ok");
}

bool moveMotor(int degrees) {
  while (MotorLink.available()) MotorLink.read();

  unsigned long began = millis();
  MotorLink.printf("MOTOR:%d\n", degrees);
  Serial.printf("[TX->B] MOTOR:%d\n", degrees);

  String resp = "";
  unsigned long deadline = millis() + 20000UL;
  while (millis() < deadline) {
    String line = awaitMotorLine(3000);
    if (line.length()) {
      Serial.println("[RX<-B] " + line);
      int at = line.indexOf("M:");
      if (at >= 0) { resp = line.substring(at); break; }
    }
    feedWdt();
  }

  bool ok = resp.startsWith("M:ok");
  unsigned long took = millis() - began;

  long steps = MOTOR_STEPS_PER_REV * abs(degrees) / 360L;
  unsigned long expected =
      (unsigned long)(steps * 60000.0 / (MOTOR_RPM * (double)MOTOR_STEPS_PER_REV));

  if (ok) {
    Serial.printf("[MOTOR] %+d deg took %lu ms (expected about %lu ms)\n",
                  degrees, took, expected);
    if (expected > 500 && took < expected / 2) {
      Serial.printf("*** MOTOR TOO FAST: %lu ms against %lu ms expected.\n", took, expected);
      Serial.printf("*** The motor board is not running at %d rpm. Check\n", MOTOR_RPM);
      Serial.println("*** STEPPER_RPM on Board B.");
    }
  }

  if (ok) {
    motorPositionDeg = (motorPositionDeg + degrees) % 360;
    saveMotorPosition();
    lastMotorMove = millis();
  }
  writeMotorLog(degrees, ok, took);
  return ok;
}

// Returns true only when Board B acknowledged with something that is not a
// failure. The callers that reset the tracked angle depend on this: sending
// HOME and assuming it worked is how the portal ends up reporting 0 degrees
// while the mount sits at 45.
bool relayToMotorBoard(const char* command, unsigned long waitMs) {
  while (MotorLink.available()) MotorLink.read();
  MotorLink.println(command);
  Serial.printf("[TX->B] %s\n", command);

  unsigned long deadline = millis() + waitMs;
  bool heard = false, acked = false;
  while (millis() < deadline) {
    String line = awaitMotorLine(2000);
    if (line.length()) {
      Serial.println("[RX<-B] " + line);
      heard = true;
      if (line.indexOf("M:fail") >= 0) break;
      if (line.indexOf("M:ok") >= 0 || line.indexOf("Z:ok") >= 0 ||
          line.indexOf("S:") >= 0) { acked = true; break; }
      if (line.indexOf("M:") >= 0 || line.indexOf("Z:") >= 0) break;
    }
    feedWdt();
  }
  if (!heard) Serial.println("[WARN] no reply from the motor board");
  return acked;
}

int readLastImageTimestamp() {
  // A single Firebase call can block far longer than its configured timeout
  // while TLS is failing, and the watchdog does not care why the loop stopped
  // reporting. Feed it either side, and do not make the call at all when the
  // link is already known to be down.
  if (cloudPaused() || !Firebase.ready()) return -1;
  feedWdt();
  bool ok = Firebase.getInt(fbdo, "/sensors/camera/lastImageTimestamp");
  feedWdt();
  if (ok) return fbdo.intData();
  return -1;
}

void requestCapture(const char* folder, int set, int frame) {
  FirebaseJson j;
  j.set("capture_requested", (int)time(nullptr));
  j.set("capture_target", folder);
  j.set("capture_set", set);
  j.set("capture_frame", frame);
  Firebase.updateNode(fbdo, "/sensors/camera/control", j);
  Serial.printf("[CAM] capture requested -> %s set %d frame %d\n", folder, set, frame);
  feedWdt();
}

bool captureAndConfirm(const char* folder, int set, int frame, unsigned long timeoutMs) {
  int before = readLastImageTimestamp();
  requestCapture(folder, set, frame);

  unsigned long start = millis();
  while (millis() - start < timeoutMs) {
    delay(1500);
    feedWdt();
    if (cloudPaused()) {          // the camera is reached only through the cloud
      Serial.println("[CAM] abandoning the wait: the cloud went down mid-capture");
      return false;
    }
    int now = readLastImageTimestamp();
    if (now > 0 && now != before) {
      Serial.printf("[CAM] confirmed after %lu ms\n", millis() - start);
      return true;
    }
  }

  Serial.printf("[CAM] NO CONFIRMATION after %lu ms\n", timeoutMs);
  return false;
}

void commandLight(bool wanted, bool restoring) {
  Serial.printf("[LIGHT] %s %s\n",
                restoring ? "restoring" : "portal requested",
                wanted ? "ON" : "OFF");

  wakeSensorBoard();
  Serial1.printf("L:%d\n", wanted ? 1 : 0);
  Serial.printf("[TX->C] L:%d\n", wanted ? 1 : 0);

  String reply = "";
  unsigned long deadline = millis() + 10000UL;
  while (millis() < deadline) {
    String l = awaitSensorLine(2000);
    if (l.length()) {
      Serial.println("[RX<-C] " + l);
      if (l.startsWith("L:")) { reply = l; break; }
    }
    feedWdt();
  }

  if (reply.startsWith("L:")) {
    lightCommandedOn = wanted;
    Firebase.setBool(fbdo, "/sensors/system/light_is_on", wanted);
    Serial.println("[LIGHT] confirmed by Board C");
  } else {
    Serial.println("[LIGHT] no confirmation from Board C");
  }
  feedWdt();
}

void runMoistureCheck(bool manualTrigger) {
  Serial.printf("\n===== MOISTURE CHECK (%s) =====\n",
                manualTrigger ? "manual" : "scheduled");
  setActivity("check", manualTrigger ? "manual check" : "scheduled check");

  wakeSensorBoard();
  pushConfigToSensorBoard();

  int stepsPerCollection = cfgCollectionIntervalM / 60;
  if (stepsPerCollection < 1) stepsPerCollection = 1;
  bool willCollect = cfgDataCollectEnabled &&
                     (checksSinceCollection + 1 >= stepsPerCollection);

  Serial1.println("W:0");
  String line = awaitSensorLine(8000);
  Serial.println("[RX<-C] " + line);

  float temp = 0, hum = 0;
  int soil = -1;

  // FIVE FIELDS: temp, humidity, soil, reservoir gap, light.
  //
  // Board C has sent five since 5 Oct. This parser read three and threw the
  // rest away, so a working rangefinder and a working light sensor both
  // produced numbers on the serial monitor and nothing in the database.
  //
  // Fields 4 and 5 default to -1 and are only overwritten if the commas are
  // actually there, so a three-field line from an older Board C still parses
  // exactly as it used to.
  int rangeMm = -1, lightRaw = -1;
  if (line.startsWith("D:")) {
    line.remove(0, 2);
    int c1 = line.indexOf(',');
    int c2 = line.indexOf(',', c1 + 1);
    int c3 = line.indexOf(',', c2 + 1);
    int c4 = (c3 > 0) ? line.indexOf(',', c3 + 1) : -1;
    if (c1 > 0 && c2 > 0) {
      temp = line.substring(0, c1).toFloat();
      hum  = line.substring(c1 + 1, c2).toFloat();
      soil = (c3 > 0) ? line.substring(c2 + 1, c3).toInt()
                      : line.substring(c2 + 1).toInt();
      if (c3 > 0) rangeMm  = (c4 > 0) ? line.substring(c3 + 1, c4).toInt()
                                      : line.substring(c3 + 1).toInt();
      if (c4 > 0) lightRaw = line.substring(c4 + 1).toInt();
    }
  }

  if (soil < 0) {
    consecutiveSensorFailures++;
    Serial.printf("[WARN] no reading from Board C (%d consecutive)\n",
                  consecutiveSensorFailures);
    writeAutomationLog('U', 'U', cfgDataCollectEnabled ? 'T' : 'F', -1, "board_a");

    // ESCALATION LADDER.
    //
    // The old behaviour was to emit an identical warning and try again,
    // forever. On 2 Oct that produced twenty-four identical notifications
    // across 3.7 hours while nothing was done and nothing was learned.
    // Repetition is not escalation.
    if (consecutiveSensorFailures >= SENSOR_FAILS_BEFORE_RESET &&
        sensorResetsIssued < SENSOR_RESETS_BEFORE_GIVEUP) {
      resetSensorBoard();
      consecutiveSensorFailures = 0;      // give the reset a fair chance
      pushNotification("sensor_reset", "warning",
                       "The sensor board stopped replying and was reset.",
                       INT32_MIN, cfgNotifySensorFail);
    } else if (sensorResetsIssued >= SENSOR_RESETS_BEFORE_GIVEUP &&
               !sensorUnrecoverableSent) {
      // One distinct notification, once. Board C's own failsafe is
      // independent of this board and keeps the plant alive meanwhile, so
      // this is a maintenance alert, not an emergency.
      sensorUnrecoverableSent = true;
      pushNotification("sensor_unrecoverable", "critical",
                       "The sensor board has not replied after three hard "
                       "resets. Check its power and the shared ground. The "
                       "sensor board's own failsafe continues to run "
                       "independently.",
                       INT32_MIN, cfgNotifySensorFail);
      Firebase.setString(fbdo, "/sensors/system/sensor_state", "unrecoverable");
    } else if (!sensorUnrecoverableSent) {
      pushNotification("sensor_no_response", "warning",
                       "The sensor board did not reply to a scheduled reading.",
                       INT32_MIN, cfgNotifySensorFail);
    }

    clearActivity("sensor_no_response");
    return;
  }

  // A good reading clears the whole ladder: the board is talking again.
  if (consecutiveSensorFailures || sensorResetsIssued || sensorUnrecoverableSent) {
    Serial.printf("[RECOVER] Board C is answering again after %d resets\n",
                  sensorResetsIssued);
    if (sensorUnrecoverableSent) {
      Firebase.setString(fbdo, "/sensors/system/sensor_state", "ok");
      pushNotification("sensor_recovered", "info",
                       "The sensor board is replying again.",
                       soil, cfgNotifySensorFail);
    }
    consecutiveSensorFailures = 0;
    sensorResetsIssued        = 0;
    sensorUnrecoverableSent   = false;
  }

  // RESERVOIR LEVEL, derived before the watering decision so it can inform it.
  // -1 means unknown, which is not the same as empty and must never be treated
  // as a low level: an overfilled bin and a failed sensor both return no echo.
  int  resPct   = reservoirPercent(rangeMm);
  bool resEmpty = (resPct >= 0 && resPct <= cfgReservoirEmptyPct);

  bool watered = false;
  bool belowThreshold = (soil < cfgThresholdPct);
  bool cooldownClear  = (lastWateredEpoch == 0) ||
        ((time(nullptr) - lastWateredEpoch) >= (time_t)cfgMinWaterHours * 3600);

  // A capacitive probe that has come out of the soil, lost its ground, or had
  // its signal line pulled reads 0 %, and 0 % is below every threshold the
  // portal can set. From 23 Sep 07:44 to 24 Sep 11:55 this board recorded a
  // continuous 0 % and watered on it. A reading of exactly zero is not a dry
  // pot; a pot that dry does not exist in a system that was watering it
  // hours earlier. Treat the bottom of the range as a fault, not a value.
  //
  // SOIL_FAULT_PCT is deliberately above 0: the probe's dry-air calibration
  // point sits a little over zero, so a genuine bone-dry pot still reads
  // above this, while a disconnected probe sits at or below it.
  const int SOIL_FAULT_PCT = 2;
  bool soilPlausible = (soil > SOIL_FAULT_PCT && soil <= 100);

  // The veto suppresses WATERING only. The reading still goes to history,
  // because the climate half is read by a different sensor on a different pin
  // and stays good, and because a stored run of 0 % is the evidence that the
  // probe failed. Returning early here would delete that evidence.
  if (!soilPlausible) {
    Serial.printf("[VETO] soil reads %d%% - probe fault, watering held\n", soil);
    pushNotification("sensor_no_response", "warning",
                     "The soil probe is reading at the bottom of its range, which "
                     "indicates a disconnected or failed probe rather than dry soil. "
                     "Automatic watering is held until it reads plausibly again.",
                     soil, cfgNotifySensorFail);
  }

  // The reservoir veto is OFF unless asked for. Running the pump dry is bad for
  // it, but a level sensor that has already failed once in service is a poor
  // thing to make watering depend on - a miscalibration would quietly stop the
  // plant being watered at all, and that failure is silent where a dry pump is
  // audible.
  if (cfgBlockWaterWhenEmpty && resEmpty && belowThreshold) {
    Serial.printf("[VETO] reservoir at %d%% - watering held\n", resPct);
  }

  if (cfgAutoWaterEnabled && soilPlausible && belowThreshold && cooldownClear &&
      !(cfgBlockWaterWhenEmpty && resEmpty)) {
    Serial.printf("[AUTO] soil %d%% below %d%% - watering\n", soil, cfgThresholdPct);
    setActivityDetail("watering");

    delay(1500);
    wakeSensorBoard();
    pushConfigToSensorBoard();
    watered = commandPumpAndAwaitResult();

    if (watered) {
      noteWatered(time(nullptr));
      pushNotification("watered", "info",
                       manualTrigger ? "Watered after a manual check."
                                     : "Watered automatically: soil below threshold.",
                       soil, cfgNotifyWatered);
    }
  } else if (belowThreshold && !cooldownClear) {
    Serial.println("[AUTO] below threshold but cooldown active - not watering");
    if (!soilLowActive || notifyDue(&lastNotifySoilLow)) {
      soilLowActive = true;
      lastNotifySoilLow = time(nullptr);
      pushNotification("soil_low", "warning",
                       "Soil is below the threshold but the watering cooldown has not expired.",
                       soil, cfgNotifySoilLow);
    }
  } else if (belowThreshold && !cfgAutoWaterEnabled) {
    if (!soilLowActive || notifyDue(&lastNotifySoilLow)) {
      soilLowActive = true;
      lastNotifySoilLow = time(nullptr);
      pushNotification("soil_low", "warning",
                       "Soil is below the threshold and automatic watering is switched off.",
                       soil, cfgNotifySoilLow);
    }
  }

  // The condition cleared. Said once, then the latch resets so the next spell
  // of dry soil announces itself immediately rather than waiting out the
  // repeat interval.
  if (soilLowActive && soilPlausible && !belowThreshold) {
    soilLowActive = false;
    pushNotification("soil_recovered", "info",
                     "Soil is back above the watering threshold.",
                     soil, cfgNotifySoilLow);
  }

  // ------------------------------------------------------------------
  // CLIMATE VALIDITY
  //
  // Board C sends CLIMATE_INVALID (-99.9) when the DHT22 does not answer or
  // answers 0.0/0.0 with a good checksum, which is what a downed data line
  // produces. That sentinel must never reach history, because every stage
  // downstream will treat it as a measurement: vpd(-99.9, -99.9) evaluates
  // without error, enters the regression as a real point, and manufactures
  // VPD spread. Spread is what the confidence term is computed from, so a
  // dead sensor would raise the model's stated confidence.
  //
  // The soil probe is a separate sensor on a separate pin and stays good, so
  // the row is still written — the climate FIELDS are simply omitted. A
  // missing field reads as not-finite in both the portal and the model, and
  // both already drop it. A present -99.9 would not.
  // ------------------------------------------------------------------
  bool climateOk = (temp > -50.0f && temp < 100.0f &&
                    hum >= 0.0f && hum <= 100.0f);

  if (!climateOk) {
    Serial.printf("[CLIMATE] invalid (%.1f C / %.1f %%) - omitted from history\n",
                  temp, hum);
    if (notifyDue(&lastNotifyTempRange)) {
      pushNotification("sensor_no_response", "warning",
                       "The climate sensor did not return a reading. Soil is "
                       "still being recorded; temperature and humidity are not.",
                       INT32_MIN, cfgNotifySensorFail);
    }
  } else if (temp < (float)cfgTempMinC || temp > (float)cfgTempMaxC) {
    if (notifyDue(&lastNotifyTempRange)) {
      char msg[96];
      snprintf(msg, sizeof(msg),
               "Temperature %.1f C is outside the configured range of %d to %d C.",
               temp, cfgTempMinC, cfgTempMaxC);
      pushNotification("temp_out_of_range", "warning", msg, (int)temp, cfgNotifyTempRange);
    }
    tempOutActive = true;
  } else if (climateOk && tempOutActive) {
    tempOutActive = false;
    char msg[96];
    snprintf(msg, sizeof(msg), "Temperature %.1f C is back inside %d to %d C.",
             temp, cfgTempMinC, cfgTempMaxC);
    pushNotification("temp_recovered", "info", msg, (int)temp, cfgNotifyTempRange);
  }

  // ------------------------------------------------------------------
  // RESERVOIR NOTIFICATIONS
  //
  // Three states and a recovery, latched so each announces itself once and
  // then holds its peace until the repeat interval. Unknown is reported as
  // unknown rather than as empty, because the two look identical to the
  // sensor and only one of them is an emergency.
  // ------------------------------------------------------------------
  if (resPct < 0) {
    if (notifyDue(&lastNotifyReservoir)) {
      pushNotification("reservoir_unknown", "warning",
                       "The reservoir rangefinder returned no echo, so the water level "
                       "is unknown. A bin filled past the sensor's blind spot reads the "
                       "same as a failed sensor; check the level by eye.",
                       INT32_MIN, cfgNotifyReservoir);
    }
  } else {
    int want = resEmpty ? 2 : (resPct <= cfgReservoirLowPct ? 1 : 0);

    if (want > 0) {
      // Escalation pre-empts the repeat interval; an unchanged condition does not.
      bool escalated = (want > reservoirState);
      if (escalated || notifyDue(&lastNotifyReservoir)) {
        lastNotifyReservoir = time(nullptr);
        char msg[136];
        if (want == 2) {
          snprintf(msg, sizeof(msg),
                   "The reservoir is at %d%%. The next watering may draw air, and the "
                   "pump should not be run dry. Refill it.", resPct);
          // Sent whatever the notification preferences say, like the failsafe
          // report: this is the state in which the system cannot do its job.
          pushNotification("reservoir_empty", "critical", msg, resPct, true);
        } else {
          snprintf(msg, sizeof(msg),
                   "The reservoir is at %d%%, below the %d%% mark. There is still water, "
                   "but not many waterings left in it.", resPct, cfgReservoirLowPct);
          pushNotification("reservoir_low", "warning", msg, resPct, cfgNotifyReservoir);
        }
      }
      reservoirState = want;      // tracked even when the notice was held back
    } else if (reservoirState > 0) {
      reservoirState = 0;
      char msg[96];
      snprintf(msg, sizeof(msg), "The reservoir is back to %d%%.", resPct);
      pushNotification("reservoir_refilled", "info", msg, resPct, cfgNotifyReservoir);
    }
  }

  bool collected = false;
  if (willCollect) {
    FirebaseJson j;
    if (climateOk) {
      j.set("temperature_c", temp);
      j.set("humidity_percent", hum);
    } else {
      j.set("climate_ok", false);     // the gap is marked, not silent
    }
    j.set("soil_moisture_percent", soil);

    // Both the raw gap and the derived percentage. The percentage is what the
    // portal shows; the gap is what makes a recalibration non-destructive.
    // Marked absent rather than written as zero when there was no echo, the
    // same way the climate fields are handled above.
    if (rangeMm >= 0) {
      j.set("reservoir_gap_mm", rangeMm);
      int resPct = reservoirPercent(rangeMm);
      if (resPct >= 0) j.set("reservoir_percent", resPct);
    } else {
      j.set("reservoir_ok", false);
    }
    if (lightRaw >= 0 && lightRaw <= 4095) {
      j.set("light_raw", lightRaw);
    } else {
      j.set("light_ok", false);
    }

    j.set("timestamp", (int)time(nullptr));
    j.set("free_heap", (int)ESP.getFreeHeap());
    j.set("max_alloc_heap", (int)ESP.getMaxAllocHeap());
    j.set("uptime_s", (int)(millis() / 1000));

    feedWdt();
    collected = cloudPaused() ? false : Firebase.pushJSON(fbdo, "/sensors/history", j);
    feedWdt();
    if (!cloudPaused()) noteCloudResult(collected);

    if (collected) {
      Firebase.setJSON(fbdo, "/sensors/current", j);
      checksSinceCollection = 0;
    } else {
      // The reading was taken correctly; only the upload failed. Hold it with
      // its own timestamp rather than throwing away a measurement the sensors
      // already spent the energy to make.
      queuePush(temp, hum, soil, (long)time(nullptr),
                (int)ESP.getFreeHeap(), (int)ESP.getMaxAllocHeap(),
                (int)(millis() / 1000),
                rangeMm, lightRaw);
      checksSinceCollection = 0;   // the sample exists; do not re-sample early
    }
    feedWdt();
  } else {
    checksSinceCollection++;
  }

  writeAutomationLog(collected ? 'T' : 'F',
                     watered   ? 'U' : 'F',
                     cfgDataCollectEnabled ? 'T' : 'F',
                     soil, manualTrigger ? "manual_check" : "board_a");

  clearActivity(watered ? "watered" : "no_action");

  if (manualTrigger && cfgCheckSweepEnabled) {
    Serial.println("[CHECK] running the sweep for this manual check");
    runCheckSweep();
  } else if (manualTrigger) {
    Serial.println("[CHECK] sweep skipped: disabled in configuration");
  }
}

void runSweep(const int* angles, int count, const char* target, bool grouped) {
  if (!cameraReachable()) {
    Serial.println("[SWEEP] refused: the cloud is unreachable, and the camera");
    Serial.println("[SWEEP] is reached only through it. The mount has not moved.");
    return;
  }

  // GROUPED STORAGE IS OPT-IN NOW.
  //
  // The grouped path writes into one of ten rotating sets and deletes the set
  // before reusing it, so routine capture kept a rolling window of ten sweeps
  // and silently discarded everything older. For a single daily frame meant to
  // build a three-month record that is exactly wrong. Ungrouped capture passes
  // set = -1 and accumulates flat under the target, which is how the check
  // store already holds every frame it ever took.
  bool isRoutine = grouped && (strcmp(target, "routine") == 0);
  int set = isRoutine ? routineSetIndex : -1;
  unsigned long sweepBegan = millis();

  Serial.printf("\n===== SWEEP (%s, %d frames, %d deg%s) =====\n",
                target, count, angles[count - 1] - angles[0],
                isRoutine ? "" : ", ungrouped");
  if (isRoutine) Serial.printf("[SWEEP] writing to set %d\n", set);

  char detail[48];
  snprintf(detail, sizeof(detail), "%s sweep, starting", target);
  setActivity("sweep", detail);

  if (isRoutine) {
    String node = "/sensors/camera/routine/" + String(set);
    Firebase.deleteNode(fbdo, node.c_str());
    feedWdt();
  }

  int captured = 0;
  int position = 0;
  int consecutiveMisses = 0;
  const char* failure = nullptr;

  for (int i = 0; i < count; i++) {
    int wanted = angles[i];
    int delta  = wanted - position;

    Serial.printf("[SWEEP] frame %d of %d, moving to %+d deg\n", i + 1, count, wanted);
    snprintf(detail, sizeof(detail), "%s sweep, frame %d of %d", target, i + 1, count);
    setActivityDetail(detail);

    if (delta != 0) {
      bool moved = moveMotor(delta);

      // RETRY THE FIRST MOVE, ONCE.
      //
      // Of 47 recorded motor failures, 41 happened with the tracked angle at 0 -
      // the first move of a sweep, from rest. Aborting the whole sweep on that
      // one failure is what turned 28 of 112 sweeps into nothing. Homing first
      // re-establishes the reference and exercises the driver, then the move is
      // attempted again. Later frames get no retry: by then the mechanism has
      // demonstrably worked, so a failure is a real fault worth stopping for.
      if (!moved && i == 0) {
        Serial.println("[SWEEP] first move did not confirm - homing and retrying once");
        if (relayToMotorBoard("HOME", 20000)) {
          motorPositionDeg = 0;
          saveMotorPosition();
        } else {
          Serial.println("[SWEEP] the mount did not confirm the home either");
        }
        delay(500);
        moved = moveMotor(delta);
      }

      if (!moved) {
        failure = "motor_no_confirm";
        Serial.println("[SWEEP] motor did not confirm - aborting");
        break;
      }
      position = wanted;
      delay(1500);
    }

    bool got = captureAndConfirm(target, set, i, CAPTURE_TIMEOUT_MS);
    if (!got) {
      Serial.printf("[SWEEP] frame %d did not confirm, retrying once\n", i + 1);
      got = captureAndConfirm(target, set, i, CAPTURE_TIMEOUT_MS / 2);
    }

    if (got) {
      captured++;
      consecutiveMisses = 0;
    } else {
      if (!cameraReachable()) {
        Serial.println("[SWEEP] the cloud went down mid-sweep - stopping here");
        failure = "cloud_unreachable";
        break;
      }

      consecutiveMisses++;

      if (i == 0) {
        Serial.println("[SWEEP] the first frame did not confirm - the camera is");
        Serial.println("[SWEEP] not answering, so the rest would not either");
        failure = "camera_no_confirm";
        break;
      }

      if (consecutiveMisses >= 2) {
        Serial.println("[SWEEP] two frames missed in succession - the camera has stopped");
        failure = "camera_no_confirm";
        break;
      }

      Serial.printf("[SWEEP] frame %d skipped after retry\n", i + 1);
      if (failure == nullptr) failure = "partial";
    }
  }

  if (position != 0) {
    int back = (position > 180) ? (360 - position)
             : (position < -180) ? (-360 - position)
             : -position;
    Serial.printf("[SWEEP] returning to rest from %+d deg by %+d\n", position, back);
    setActivityDetail("returning to rest");
    moveMotor(back);
  }

  if (failure != nullptr) {
    Serial.println("[SWEEP] ended badly - asking the motor board to home");
    if (relayToMotorBoard("HOME", 20000)) {
      motorPositionDeg = 0;
      saveMotorPosition();
    } else {
      Serial.println("[SWEEP] home not confirmed - the tracked angle is left as it was");
    }
  }

  unsigned long sweepTook = millis() - sweepBegan;

  bool partial     = (failure != nullptr && strcmp(failure, "partial") == 0);
  bool unreachable = (failure != nullptr && strcmp(failure, "cloud_unreachable") == 0);
  bool complete    = (failure == nullptr);

  FirebaseJson j;
  j.set("timestamp", (int)time(nullptr));
  j.set("target", target);
  j.set("frames_captured", captured);
  j.set("frames_expected", count);
  j.set("sweep_degrees", angles[count - 1] - angles[0]);
  j.set("took_ms", (int)sweepTook);
  j.set("result", complete ? "ok" : failure);
  if (isRoutine) j.set("set", set);
  Firebase.pushJSON(fbdo, "/sensors/survey_log", j);
  feedWdt();

  if (complete) {
    Serial.printf("[SWEEP] complete in %lu ms: %d frames over %d degrees\n",
                  sweepTook, captured, angles[count - 1] - angles[0]);
    Firebase.deleteNode(fbdo, "/sensors/system/last_survey_error");
  } else if (partial) {
    Serial.printf("[SWEEP] partial in %lu ms: %d of %d frames captured\n",
                  sweepTook, captured, count);
    Firebase.setString(fbdo, "/sensors/system/last_survey_error", "partial");
    pushNotification("capture_failed", "info",
                     "A sweep completed with some frames missing.",
                     captured, cfgNotifyCaptureFail);
  } else if (unreachable) {
    Serial.printf("[SWEEP] stopped after %lu ms: the cloud became unreachable "
                  "with %d of %d frames captured\n", sweepTook, captured, count);
    Firebase.setString(fbdo, "/sensors/system/last_survey_error", "cloud_unreachable");
  } else {
    Serial.printf("[SWEEP] aborted after %lu ms: %d of %d captured (%s)\n",
                  sweepTook, captured, count, failure);
    Firebase.setString(fbdo, "/sensors/system/last_survey_error", failure);
    pushNotification("capture_failed", "info",
                     "A photographic sweep stopped early.",
                     captured, cfgNotifyCaptureFail);
  }

  if (isRoutine) {
    routineSetIndex = (routineSetIndex + 1) % ROUTINE_SETS;
    Firebase.setInt(fbdo, "/sensors/camera/next_routine_set", routineSetIndex);
  }

  clearActivity(complete ? "ok" : failure);
}

void runPhotoSurvey() {
  int angles[SWEEP_FRAMES_MAX];
  buildSweepAngles(angles, cfgRoutineFrames, cfgRoutineSpanDeg);
  runSweep(angles, cfgRoutineFrames, "routine", false);   // flat, never pruned here
}

void runCheckSweep() {
  int angles[SWEEP_FRAMES_MAX];
  buildSweepAngles(angles, cfgCheckFrames, cfgCheckSpanDeg);
  runSweep(angles, cfgCheckFrames, "check", true);
}

void runManualSweep(int spanDeg, int frames) {
  spanDeg = nearestAllowedSpan("manual sweep span", spanDeg, cfgManualSweepSpanDeg);
  frames  = clampCfg("manual sweep frames", frames, SWEEP_FRAMES_MIN, SWEEP_FRAMES_MAX);

  cfgManualSweepSpanDeg = spanDeg;
  cfgManualSweepFrames  = frames;

  Serial.printf("[MANUAL] sweep at %d degrees in %d frames\n", spanDeg, frames);

  int angles[SWEEP_FRAMES_MAX];
  buildSweepAngles(angles, frames, spanDeg);
  runSweep(angles, frames, "check", true);
}

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600, SERIAL_8N1, 33, 32);
  MotorLink.begin(9600, SERIAL_8N1, CRASHHANDLER_RX_PIN, CRASHHANDLER_TX_PIN);

  pinMode(WAKE_PIN, OUTPUT);
  digitalWrite(WAKE_PIN, LOW);

  // Held as INPUT so the target's own pull-up governs EN. It becomes an
  // output only for the 200 ms of a reset pulse. See SENSOR_RESET_PIN.
  pinMode(SENSOR_RESET_PIN, INPUT);

  WiFiManager wm;

  // WITHOUT THESE TWO LINES AN UNATTENDED SYSTEM DIES AT THE FIRST WI-FI BLIP.
  //
  // When autoConnect() fails it raises a configuration access point and blocks
  // inside its web portal, waiting for a person to open a browser. With no
  // timeout it waits forever. Observed on 2 Oct: the access point became
  // unreachable, the board fell into the portal, and the rig stopped checking
  // the plant entirely until it was power-cycled by hand — it had been left
  // running deliberately for two days.
  //
  // setConfigPortalTimeout makes the portal give up and hand control back, so
  // the board carries on offline: Board C is still read, readings are still
  // queued to NVS, and the existing "nothing has succeeded for 10 minutes"
  // restart retries the network from a clean boot. setConnectTimeout stops a
  // single join attempt from consuming a minute before that can begin.
  wm.setConnectTimeout(WIFI_JOIN_TIMEOUT_S);
  wm.setConfigPortalTimeout(PORTAL_TIMEOUT_S);

  if (!wm.autoConnect("Master_Watering_System", "admin123")) {
    // THE PORTAL CLOSED WITH NO NEW CREDENTIALS, SO THE OLD ONES ARE THE
    // BEST GUESS AVAILABLE.
    //
    // WiFiManager cannot distinguish a wrong password from a router that is
    // briefly unreachable: both present as a failed join, and it responds to
    // both by asking a human for new credentials. For a device that sits
    // beside the same access point every day, the stored credentials are
    // almost never the problem. On 2 Oct the saved network was correct and
    // simply unreachable for 58 s, and the board spent the rest of the
    // evening offering a setup page to an empty room.
    //
    // So when nobody supplies new credentials, go straight back to the
    // stored ones. WiFi.begin() with no arguments reuses what is already in
    // flash and never raises the portal again.
    Serial.printf("[WIFI] no new credentials after %d s - retrying the saved network\n",
                  PORTAL_TIMEOUT_S);

    WiFi.mode(WIFI_STA);
    WiFi.begin();
    unsigned long began = millis();
    while (WiFi.status() != WL_CONNECTED &&
           millis() - began < (unsigned long)WIFI_RETRY_TIMEOUT_S * 1000UL) {
      delay(500);
      Serial.print(".");
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("[WIFI] saved network came back; reconnected.");
    } else {
      Serial.println("[WIFI] still unreachable - continuing offline.");
      Serial.println("[WIFI] Board C is still read and readings are queued to NVS.");
      Serial.println("[WIFI] The 10-minute cloud watchdog will restart and try again.");
    }
  }

  // Let the Wi-Fi stack re-associate by itself after a dropout, so a brief
  // outage never has to reach the restart logic at all.
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);

  WiFi.setSleep(false);
  delay(2000);

  // The watchdog is CONFIGURED here but this task is NOT registered with it
  // until the end of setup(). See the note above esp_task_wdt_add() below.
  esp_task_wdt_config_t wdt = { .timeout_ms = WDT_TIMEOUT_SEC * 1000,
                                .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_reconfigure(&wdt);

  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
  struct tm ti; int tries = 0;
  Serial.print("Syncing time");
  while (!getLocalTime(&ti) && tries < 15) { delay(1000); Serial.print("."); feedWdt(); tries++; }
  Serial.println(tries >= 15 ? "\nno NTP" : "\ntime synced");

  Serial.printf("[BASELINE] free_heap=%u max_alloc=%u\n",
                ESP.getFreeHeap(), ESP.getMaxAllocHeap());

  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  // A handshake on a congested link needs more than 5 s before it is fair to
  // call it failed; cutting it short manufactures failures that would have
  // succeeded. The receive buffer goes to 16 KB because the measurements of
  // Chapter 5 show 110,580 B available as one block - there is room, and a
  // larger buffer survives a certificate chain arriving in fragments.
  config.timeout.sslHandshake   = 12000;
  config.timeout.serverResponse = 10000;
  fbdo.setResponseSize(4096);
  fbdo.setBSSLBufferSize(16384, 2048);

  // Firebase.signUp() is a blocking TLS exchange with no way to feed a
  // watchdog from inside it. On 2 Oct the SSL layer hung here, the 90 s task
  // watchdog fired mid-call, and the board panicked with a backtrace instead
  // of simply failing to sign up and carrying on:
  //
  //   Sign-up FAILED:
  //   E task_wdt: Task watchdog got triggered ... loopTask (CPU 1) ... Aborting.
  //
  // The fix is ordering, not a longer timeout: this task is registered with
  // the watchdog AFTER setup() finishes. The watchdog exists to catch a loop
  // that stops making progress, and setup() is already bounded by its own
  // connect and auth timeouts.
  Serial.println("Attempting anonymous sign-up...");
  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Anonymous sign-up successful.");
  } else {
    Serial.println("Sign-up FAILED: " +
                   String(config.signer.signupError.message.c_str()));
  }

  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  Serial.print("Waiting for Firebase auth");
  unsigned long authStart = millis();
  while (!Firebase.ready() && millis() - authStart < 20000) {
    delay(250);
    Serial.print(".");
    feedWdt();
  }
  Serial.println(Firebase.ready() ? " ready." : " TIMED OUT.");
  feedWdt();

  lastCloudSuccess = millis();

  queueInit();
  motorPositionDeg = qstore.getInt("motorpos", 0);
  if (motorPositionDeg != 0) {
    Serial.printf("[MOUNT] restored tracked angle %d deg from before the restart\n",
                  motorPositionDeg);
    lastMotorMove = millis();        // start the idle clock, do not move yet
  }
  restoreLastWatered();      // MUST come before the first moisture check
  fetchConfig();
  clearStaleCommands();

  currentActivity = "idle";
  activityBegan = 0;
  if (Firebase.ready()) {
    FirebaseJson j;
    j.set("activity", "idle");
    j.set("activity_detail", "");
    Firebase.updateNode(fbdo, "/sensors/system", j);
  }

  if (cfgTestMode) {
    Serial.println("*** TEST MODE: shortened intervals. Switch it off in the portal ***");
    Serial.println("*** before leaving the system running unattended.            ***");
  }
  Serial.printf("[SCHED] %s mode: moisture check every %lu min, photo survey every %lu min\n",
                cfgTestMode ? "TEST" : "NORMAL",
                moistureCheckMs() / 60000UL, photoSurveyMs() / 60000UL);
  Serial.printf("[POLL] control node read every %lu ms\n", controlPollMs());
  Serial.printf("[WDT] watchdog at %d s\n", WDT_TIMEOUT_SEC);
  Serial.printf("[QUEUE] capacity %d readings, %d waiting\n", QUEUE_MAX, qCount);
  Serial.printf("[MOTOR] expecting %d rpm: a 90 degree move should take about %lu ms\n",
                MOTOR_RPM,
                (unsigned long)(512.0 * 60000.0 / (MOTOR_RPM * (double)MOTOR_STEPS_PER_REV)));

  if (Firebase.getInt(fbdo, "/sensors/camera/next_routine_set")) {
    routineSetIndex = fbdo.intData() % ROUTINE_SETS;
  }
  Serial.printf("[SWEEP] next routine set %d of %d\n", routineSetIndex, ROUTINE_SETS);

  MotorLink.println("BOOT");

  // SEEDED IN THE PAST so the first scheduled check runs a minute after boot
  // instead of one whole interval later.
  //
  // These used to be set to millis(), which meant a restart discarded however
  // much of the interval had already elapsed and began counting again. A
  // reboot 25 minutes into a 30-minute interval therefore produced a 55-minute
  // gap, and a board cycling on a bad network could starve the schedule
  // indefinitely.
  //
  // The subtraction underflows, and that is intended: both operands are
  // unsigned long, so the wrap cancels in the comparison. Written out, the
  // loop's test becomes (millis() - m0) + I - D >= I, which first passes once
  // D has elapsed and every I thereafter.
  //
  // Consequence worth knowing: a real check, with every gate it normally has,
  // runs 60 s after any boot. restoreLastWatered() runs before this, so the
  // cooldown is honoured.
  const unsigned long FIRST_CHECK_DELAY_MS  = 60000UL;
  const unsigned long FIRST_SURVEY_DELAY_MS = 150000UL;
  lastMoistureCheck = millis() - moistureCheckMs() + FIRST_CHECK_DELAY_MS;

  // THE SURVEY TIMER COULD NEVER REACH ITS OWN INTERVAL.
  //
  // This was seeded with millis() at the END of setup, while the scheduled
  // restart counts from boot. Both are six hours, so the restart arrived first
  // by however long setup had taken - every cycle, forever. In normal mode the
  // routine capture never ran once; the sweeps in the record are all from
  // periods when test mode shortened the survey interval to thirty minutes.
  //
  // Seeded in the past like the moisture check, so the capture happens shortly
  // after each boot instead of at an interval the board never survives to see.
  // Staggered 90 s behind the check so the two do not contend for Board C and
  // the cloud at the same moment.
  lastPhotoSurvey   = millis() - photoSurveyMs() + FIRST_SURVEY_DELAY_MS;

  if (photoSurveyMs() >= RESTART_INTERVAL_MS) {
    Serial.printf("[SCHED] survey interval %lu min is not shorter than the %lu min "
                  "maintenance restart, so the capture after each boot is the only "
                  "one that runs. Shorten the interval to get more.\n",
                  photoSurveyMs() / 60000UL, RESTART_INTERVAL_MS / 60000UL);
  }

  // ARM THE WATCHDOG LAST.
  //
  // Everything above is startup: joining the network, syncing the clock,
  // authenticating, reading configuration. Each of those is a blocking call
  // that cannot feed a watchdog from inside itself, and each is already
  // bounded by its own timeout. Registering this task earlier meant a slow
  // TLS handshake during startup was indistinguishable from a seized main
  // loop, and the board panicked rather than reporting a failed sign-up.
  //
  // From here the watchdog guards what it was meant to guard: the loop.
  esp_task_wdt_add(NULL);
  feedWdt();
}

void loop() {
  feedWdt();

  // Before anything that needs the network. Cheap: returns immediately
  // unless 15 s have passed, and does nothing at all while the link is up.
  maintainWifi();

  static String usbLine = "";
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      usbLine.trim();

      if (usbLine.equalsIgnoreCase("PUMP")) {
        Serial.println("[SERIAL] pump requested");
        setActivity("pump", "manual watering");
        wakeSensorBoard();
        pushConfigToSensorBoard();
        bool ok = commandPumpAndAwaitResult();
        Serial.printf("[SERIAL] pump result: %s\n", ok ? "ok" : "no confirmation");
        clearActivity(ok ? "watered" : "no_confirmation");

      } else if (usbLine.equalsIgnoreCase("CHECK")) {
        Serial.println("[SERIAL] moisture check requested");
        fetchConfig();
        runMoistureCheck(true);

      } else if (usbLine.equalsIgnoreCase("SWEEP")) {
        Serial.println("[SERIAL] routine sweep requested");
        fetchConfig();
        runPhotoSurvey();

      } else if (usbLine.equalsIgnoreCase("SWEEP90")) {
        fetchConfig();
        runManualSweep(90, cfgManualSweepFrames);

      } else if (usbLine.equalsIgnoreCase("SWEEP180")) {
        fetchConfig();
        runManualSweep(180, cfgManualSweepFrames);

      } else if (usbLine.equalsIgnoreCase("LIGHT")) {
        commandLight(!lightCommandedOn, false);

      } else if (usbLine.equalsIgnoreCase("CAM")) {
        if (!cameraReachable()) {
          Serial.println("[SERIAL] refused: the camera is reached through the");
          Serial.println("[SERIAL] database, which is currently unreachable.");
        } else {
          Serial.println("[SERIAL] capture requested");
          setActivity("capture", "single frame");
          bool ok = captureAndConfirm("check", -1, 0, CAPTURE_TIMEOUT_MS);
          clearActivity(ok ? "ok" : "no_confirmation");
        }

      } else if (usbLine.equalsIgnoreCase("STATUS")) {
        Serial.printf("[STATUS] uptime=%lus free=%u max_alloc=%u\n",
                      millis() / 1000, ESP.getFreeHeap(), ESP.getMaxAllocHeap());
        Serial.printf("[STATUS] wifi=%s firebase=%s camera=%s\n",
                      WiFi.status() == WL_CONNECTED ? "connected" : "DOWN",
                      Firebase.ready() ? "ready" : "NOT READY",
                      cameraReachable() ? "reachable" : "UNREACHABLE");
        Serial.printf("[STATUS] activity=%s cloud failures=%d%s\n",
                      currentActivity, consecutiveCloudFailures,
                      cloudPaused() ? "  (backing off)" : "");
        Serial.printf("[STATUS] last cloud success %lus ago\n",
                      (millis() - lastCloudSuccess) / 1000);
        Serial.printf("[STATUS] poll every %lums, motor at %d rpm, wdt %ds\n",
                      controlPollMs(), MOTOR_RPM, WDT_TIMEOUT_SEC);
        Serial.printf("[STATUS] mode=%s, check every %lu min, survey every %lu min\n",
                      cfgTestMode ? "TEST" : "NORMAL",
                      moistureCheckMs() / 60000UL, photoSurveyMs() / 60000UL);
        Serial.printf("[STATUS] routine %dx%ddeg, check %dx%ddeg, manual %dx%ddeg\n",
                      cfgRoutineFrames, cfgRoutineSpanDeg,
                      cfgCheckFrames, cfgCheckSpanDeg,
                      cfgManualSweepFrames, cfgManualSweepSpanDeg);
        Serial.printf("[STATUS] next routine set %d, tracked angle %d deg, light %s\n",
                      routineSetIndex, motorPositionDeg,
                      lightCommandedOn ? "on" : "off");

      } else if (usbLine.equalsIgnoreCase("HOME")) {
        Serial.println("[SERIAL] returning the mount to its reference angle");
        if (relayToMotorBoard("HOME", 20000)) { motorPositionDeg = 0; saveMotorPosition(); }

      } else if (usbLine.equalsIgnoreCase("ZERO")) {
        Serial.println("[SERIAL] declaring the current angle to be the reference");
        if (relayToMotorBoard("ZERO", 5000)) { motorPositionDeg = 0; saveMotorPosition(); }

      } else if (usbLine.equalsIgnoreCase("RESUME")) {
        Serial.println("[SERIAL] returning to the last starting angle");
        relayToMotorBoard("RESUME", 20000);

      } else if (usbLine.equalsIgnoreCase("STOP")) {
        relayToMotorBoard("STOP", 3000);

      } else if (usbLine.equalsIgnoreCase("POS")) {
        relayToMotorBoard("STATUS", 5000);

      } else if (usbLine.equalsIgnoreCase("CLEAR")) {
        clearStaleCommands();

      } else if (usbLine.equalsIgnoreCase("REBOOT")) {
        Serial.println("[SERIAL] restarting");
        delay(500);
        ESP.restart();

      } else if (usbLine.length() > 1 &&
                 (usbLine[0] == 'N' || usbLine[0] == 'n')) {
        int deg = usbLine.substring(1).toInt();
        char cmd[12];
        snprintf(cmd, sizeof(cmd), "N%d", deg);
        Serial.printf("[SERIAL] nudge %+d deg\n", deg);
        relayToMotorBoard(cmd, 10000);

      } else if (usbLine.length() > 1 &&
                 (usbLine[0] == 'M' || usbLine[0] == 'm')) {
        int ang = usbLine.substring(1).toInt();
        if (ang == 0) {
          Serial.println("[SERIAL] zero is not a movement; use M45 or M-45");
        } else {
          Serial.printf("[SERIAL] motor %d deg\n", ang);
          moveMotor(ang);
        }

      } else if (usbLine.length()) {
        Serial.println("[SERIAL] unrecognised: " + usbLine);
        Serial.println("  PUMP CHECK CAM LIGHT        system actions");
        Serial.println("  SWEEP                       routine sweep, scheduled store");
        Serial.println("  SWEEP90 SWEEP180            manual sweep, check store");
        Serial.println("  M45 M-45 N5 N-5             move, nudge");
        Serial.println("  HOME ZERO RESUME STOP       position");
        Serial.println("  STATUS POS CLEAR REBOOT     state and maintenance");
      }
      usbLine = "";
    } else if (c != '\r') {
      usbLine += c;
    }
  }

  // Drain one held reading per pass while the link is healthy. Deliberately
  // one at a time: a backlog of 96 flushed in a burst would block the loop
  // long enough to trip the watchdog, which is the fault this is meant to fix.
  if (qCount > 0 && cloudHealthy() && strcmp(currentActivity, "idle") == 0) {
    queueFlushOne();
  }

  if (millis() - lastCloudSuccess > CLOUD_DEAD_MS) {
    Serial.printf("[CLOUD] nothing has succeeded for %lu minutes - restarting\n",
                  CLOUD_DEAD_MS / 60000UL);
    delay(500);
    ESP.restart();
  }

  // THE SCHEDULED CHECK RUNS WHETHER OR NOT THE CLOUD IS REACHABLE.
  //
  // This block used to sit below the three early returns beneath it, which
  // meant a cloud outage stopped the board measuring and stopped it watering.
  // That was backwards. Every sensor in this system is on the serial link, not
  // on the network: the reading can be taken, the soil can be judged and the
  // pump can be run with Firebase entirely absent.
  //
  // Nothing is lost by running it early, because runMoistureCheck() already
  // skips the push while paused and hands the reading to the NVS queue with
  // its own timestamp. queueFlushOne() above drains it when the link returns,
  // so the record arrives late and marked `deferred` rather than never.
  //
  // fetchConfig() is the one part that genuinely needs the network, so it is
  // skipped while paused and the last-known configuration is used instead.
  if (millis() - lastMoistureCheck >= moistureCheckMs()) {
    lastMoistureCheck = millis();
    if (!cloudPaused()) fetchConfig();
    runMoistureCheck(false);
  }

  if (cloudPaused()) {
    delay(100);
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    WiFi.disconnect(); WiFi.reconnect(); delay(3000); return;
  }
  if (!Firebase.ready()) { delay(200); return; }

  if (millis() - lastControlPoll > controlPollMs() && !cloudPaused()) {
    lastControlPoll = millis();
    bool ctlOk = Firebase.getJSON(fbdo, "/sensors/control");
    noteCloudResult(ctlOk);

    if (ctlOk) {
      bool wantPump = false, wantCheck = false, wantSweep = false;
      bool wantManualSweep = false, wantCapture = false;
      bool wantLight = lightCommandedOn;
      int  wantAngle = 0, wantNudge = 0;
      bool wantHome = false, wantZero = false, wantStop = false;
      int  mSpan = cfgManualSweepSpanDeg, mFrames = cfgManualSweepFrames;

      {
        FirebaseJson &j = fbdo.jsonObject();
        FirebaseJsonData d;

        j.get(d, "run_pump");              if (d.success) wantPump        = d.boolValue;
        j.get(d, "run_automation_check");  if (d.success) wantCheck       = d.boolValue;
        j.get(d, "run_sweep");             if (d.success) wantSweep       = d.boolValue;
        j.get(d, "run_manual_sweep");      if (d.success) wantManualSweep = d.boolValue;
        j.get(d, "capture_requested");     if (d.success) wantCapture     = d.boolValue;
        j.get(d, "light_on");              if (d.success) wantLight       = d.boolValue;
        j.get(d, "motor_angle");           if (d.success) wantAngle       = d.intValue;
        j.get(d, "nudge_deg");             if (d.success) wantNudge       = d.intValue;
        j.get(d, "run_home");              if (d.success) wantHome        = d.boolValue;
        j.get(d, "run_zero");              if (d.success) wantZero        = d.boolValue;
        j.get(d, "run_stop");              if (d.success) wantStop        = d.boolValue;
        j.get(d, "manual_sweep_span_deg"); if (d.success && d.intValue > 0) mSpan   = d.intValue;
        j.get(d, "manual_sweep_frames");   if (d.success && d.intValue > 0) mFrames = d.intValue;
      }

      bool handled = false;

      // STOP IS FIRST AND IGNORES `handled`.
      //
      // Every other command is one-per-poll so two buttons cannot interleave,
      // but a stop that waits its turn behind a sweep is not a stop. It is the
      // only command allowed to pre-empt.
      if (wantStop && clearCommand("/sensors/control/run_stop")) {
        Serial.println("[MOUNT] stop requested");
        relayToMotorBoard("STOP", 3000);
      }

      if (!handled && wantHome && clearCommand("/sensors/control/run_home")) {
        handled = true;
        Serial.println("[MOUNT] home requested");
        setActivity("motor", "returning the mount to home");
        bool homed = relayToMotorBoard("HOME", 20000);
        if (homed) { motorPositionDeg = 0; saveMotorPosition(); }
        lastMotorMove = millis();
        clearActivity(homed ? "homed" : "no_confirmation");
      }

      // ZERO declares wherever the mount is now to be the reference. It moves
      // nothing, so there is no confirmation to wait for beyond Board B's ack.
      if (!handled && wantZero && clearCommand("/sensors/control/run_zero")) {
        handled = true;
        Serial.println("[MOUNT] zero requested - current angle becomes the reference");
        if (relayToMotorBoard("ZERO", 5000)) {
          motorPositionDeg = 0;
          saveMotorPosition();
        } else {
          Serial.println("[MOUNT] zero not acknowledged - tracked angle unchanged");
        }
        lastMotorMove = millis();
      }

      if (!handled && wantNudge != 0) {
        if (!Firebase.setInt(fbdo, "/sensors/control/nudge_deg", 0)) {
          Serial.println("[CTL] could not clear nudge_deg - not moving");
        } else {
          handled = true;
          Serial.printf("[MOUNT] nudge %+d deg\n", wantNudge);
          setActivity("motor", "nudging the mount");
          bool ok = moveMotor(wantNudge);
          clearActivity(ok ? "ok" : "no_confirmation");
        }
      }

      if (!handled && wantPump && clearCommand("/sensors/control/run_pump")) {
        handled = true;
        Serial.println("[MANUAL] pump requested");
        setActivity("pump", "manual watering");
        wakeSensorBoard();
        pushConfigToSensorBoard();
        bool ok = commandPumpAndAwaitResult();
        if (ok) noteWatered(time(nullptr));
        writeAutomationLog('F', ok ? 'U' : 'F',
                           cfgDataCollectEnabled ? 'T' : 'F', -1, "manual");
        clearActivity(ok ? "watered" : "no_confirmation");
      }

      if (!handled && wantAngle != 0) {
        if (!Firebase.setInt(fbdo, "/sensors/control/motor_angle", 0)) {
          Serial.println("[CTL] could not clear motor_angle - not moving");
        } else {
          handled = true;
          Serial.printf("[MANUAL] motor %d deg\n", wantAngle);
          setActivity("motor", "moving the mount");
          bool ok = moveMotor(wantAngle);
          clearActivity(ok ? "ok" : "no_confirmation");
        }
      }

      if (wantLight != lightCommandedOn) {
        commandLight(wantLight, millis() < 60000);
      }

      if (!handled && wantCapture &&
          clearCommand("/sensors/control/capture_requested")) {
        handled = true;
        requestCapture("check", -1, 0);
      }

      if (!handled && wantSweep && clearCommand("/sensors/control/run_sweep")) {
        handled = true;
        Serial.println("[MANUAL] routine sweep requested");
        fetchConfig();
        runPhotoSurvey();
      }

      if (!handled && wantManualSweep &&
          clearCommand("/sensors/control/run_manual_sweep")) {
        handled = true;
        Serial.println("[MANUAL] operator sweep requested");
        fetchConfig();
        runManualSweep(mSpan, mFrames);
      }

      if (!handled && wantCheck &&
          clearCommand("/sensors/control/run_automation_check")) {
        handled = true;
        Serial.println("[MANUAL] automation check requested");
        fetchConfig();
        runMoistureCheck(true);
      }
    }
    feedWdt();
  }

  if (Serial1.available()) {
    String line = awaitSensorLine(500);
    if (line.startsWith("F:")) {
      line.remove(0, 2);
      int c = line.indexOf(',');
      int soil = line.substring(0, c).toInt();
      Serial.printf("[FAILSAFE REPORT] Board C watered autonomously at soil %d%%\n", soil);
      writeAutomationLog('F', 'U',
                         cfgDataCollectEnabled ? 'T' : 'F', soil, "board_c_failsafe");
      Firebase.setBool(fbdo, "/sensors/system/failsafe_active", true);
      pushNotification("failsafe_active", "critical",
                       "The sensor board watered autonomously after losing contact "
                       "with the controller.",
                       soil, true);
    }
  }

  if (millis() - lastPhotoSurvey >= photoSurveyMs()) {
    lastPhotoSurvey = millis();
    runPhotoSurvey();
  }

  // RETURN THE MOUNT TO HOME AFTER A SPELL OF INACTIVITY.
  //
  // Manual angle control leaves the mount wherever the operator stopped. The
  // next routine frame would then be shot from that angle, which breaks a
  // time-lapse meant to be comparable frame to frame. Only acts when the
  // tracked angle is non-zero and nothing else is running, so it can never
  // interrupt a sweep or a watering.
  if (cfgIdleHomeMinutes > 0 && motorPositionDeg != 0 && lastMotorMove != 0 &&
      strcmp(currentActivity, "idle") == 0 &&
      millis() - lastMotorMove > (unsigned long)cfgIdleHomeMinutes * 60000UL) {
    Serial.printf("[MOUNT] %+d deg from home, idle %d min - returning\n",
                  motorPositionDeg, cfgIdleHomeMinutes);
    setActivity("motor", "returning to home after inactivity");
    bool homed = relayToMotorBoard("HOME", 20000);
    if (homed) { motorPositionDeg = 0; saveMotorPosition(); }
    // The clock restarts either way, so a mount that will not home is retried
    // once per idle period rather than on every pass of the loop.
    lastMotorMove = millis();
    clearActivity(homed ? "homed_on_idle" : "home_no_confirmation");
  }

  if (millis() - lastHeartbeat > HEARTBEAT_MS) {
    lastHeartbeat = millis();
    FirebaseJson j;
    j.set("last_seen", (int)time(nullptr));
    j.set("free_heap", (int)ESP.getFreeHeap());
    j.set("max_alloc_heap", (int)ESP.getMaxAllocHeap());
    j.set("uptime_s", (int)(millis() / 1000));
    // The portal's mount panel needs to show where the camera is pointing, and
    // this is the only board that knows. Published with the heartbeat rather
    // than after each move, so a move that fails to confirm does not leave a
    // stale angle on screen looking authoritative.
    j.set("motor_angle_deg", motorPositionDeg);
    j.set("idle_home_minutes", cfgIdleHomeMinutes);
    noteCloudResult(Firebase.updateNode(fbdo, "/sensors/system", j));

    static uint32_t firstFree = 0;
    static int heapBeat = 0;
    uint32_t nowFree = ESP.getFreeHeap();
    uint32_t nowMax  = ESP.getMaxAllocHeap();
    uint32_t upS     = millis() / 1000;
    if (firstFree == 0) firstFree = nowFree;
    if (++heapBeat >= 10) {
      heapBeat = 0;
      long sinceBoot = (long)firstFree - (long)nowFree;
      float perMin = upS > 30 ? (float)sinceBoot / (upS / 60.0f) : 0.0f;
      Serial.printf("[HEAP] free=%u max_alloc=%u  %ld B since boot (%.1f B/min) uptime=%us\n",
                    nowFree, nowMax, sinceBoot, perMin, upS);
    }
    feedWdt();
  }

  if (millis() > RESTART_INTERVAL_MS) {
    Serial.println("[MAINT] scheduled restart");
    Firebase.setInt(fbdo, "/sensors/system/last_scheduled_restart", (int)time(nullptr));
    delay(500);
    ESP.restart();
  }

  delay(10);
}
