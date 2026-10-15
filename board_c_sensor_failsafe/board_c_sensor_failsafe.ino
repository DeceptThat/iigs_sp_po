#include <Arduino.h>
#include <DHT.h>
#include <Preferences.h>
#include <esp_sleep.h>
#include <driver/gpio.h>
#include <time.h>

#define DHT_PIN        16
#define DHT_TYPE       DHT11
#define SOIL_PIN       34
#define WAKE_PIN       4
#define PUMP_PIN       26
#define LIGHT_RELAY_PIN 27
#define US_TRIG_PIN    19
#define US_ECHO_PIN    18
#define LIGHT_PIN      13
#define US_ECHO_TIMEOUT_US  30000UL
#define US_SAMPLES          5
#define US_SETTLE_MS        60
#define DHT_SETTLE_MS       2000UL
#define CLIMATE_INVALID     -99.9
#define SOIL_DRY_RAW   2547
#define SOIL_WET_RAW   776
#define SELF_CHECK_INTERVAL_S   3600ULL
#define FAILSAFE_THRESHOLD_PCT  15
#define DEFAULT_TIMEOUT_HOURS   6
#define DEFAULT_PUMP_SECONDS    5

DHT dht(DHT_PIN, DHT_TYPE);
Preferences prefs;

RTC_DATA_ATTR time_t rtcLastContactFromA = 0;
RTC_DATA_ATTR time_t rtcLastWatered      = 0;
RTC_DATA_ATTR uint32_t rtcWakeCount      = 0;
RTC_DATA_ATTR bool     rtcClockValid     = false;
RTC_DATA_ATTR uint32_t rtcSilenceSeconds = 0;
RTC_DATA_ATTR uint32_t rtcSpuriousWakes = 0;
RTC_DATA_ATTR uint32_t rtcElapsedSeconds = 0;
RTC_DATA_ATTR bool rtcLightOn = false;
int cfgTimeoutHours = DEFAULT_TIMEOUT_HOURS;
int cfgPumpSeconds  = DEFAULT_PUMP_SECONDS;
time_t nowEpoch() { return rtcLastContactFromA + (time_t)(millis() / 1000); }

void loadConfig() {
  prefs.begin("failsafe", false);
  cfgTimeoutHours = prefs.getInt("timeout", DEFAULT_TIMEOUT_HOURS);
  cfgPumpSeconds  = prefs.getInt("pumpsec", DEFAULT_PUMP_SECONDS);
  prefs.end();
}

void saveConfig(int hours, int secs) {
  prefs.begin("failsafe", false);
  prefs.putInt("timeout", hours);
  prefs.putInt("pumpsec", secs);
  prefs.end();
  cfgTimeoutHours = hours;
  cfgPumpSeconds  = secs;
  Serial.printf("[CFG] timeout=%dh pump=%ds (failsafe threshold fixed at %d%%)\n",
                hours, secs, FAILSAFE_THRESHOLD_PCT);
}

int readSoilPercent(int *rawOut) {
  long sum = 0;
  for (int i = 0; i < 10; i++) { sum += analogRead(SOIL_PIN); delay(20); }
  int raw = sum / 10;
  if (rawOut) *rawOut = raw;

  long pct = map(raw, SOIL_DRY_RAW, SOIL_WET_RAW, 0, 100);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return (int)pct;
}
bool runPump(int seconds) {
  Serial.printf("[PUMP] running for %d s\n", seconds);
  digitalWrite(PUMP_PIN, LOW);
  delay((unsigned long)seconds * 1000UL);
  digitalWrite(PUMP_PIN, HIGH);
  Serial.println("[PUMP] complete");
  return true;
}
void applyLightState() {
  digitalWrite(LIGHT_RELAY_PIN, rtcLightOn ? LOW : HIGH);
  gpio_hold_en((gpio_num_t)LIGHT_RELAY_PIN);
  Serial.printf("[LIGHT] relay %s\n", rtcLightOn ? "ON" : "OFF");
}
long readEchoOnceUs() {
  digitalWrite(US_TRIG_PIN, LOW);
  delayMicroseconds(4);
  digitalWrite(US_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(US_TRIG_PIN, LOW);

  unsigned long us = pulseIn(US_ECHO_PIN, HIGH, US_ECHO_TIMEOUT_US);
  return (us == 0) ? -1L : (long)us;
}
long readEchoMedianUs() {
  long v[US_SAMPLES];
  int n = 0;
  for (int i = 0; i < US_SAMPLES; i++) {
    long r = readEchoOnceUs();
    if (r > 0) v[n++] = r;
    delay(US_SETTLE_MS);
  }
  if (n == 0) return -1L;

  for (int i = 1; i < n; i++) {
    long k = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > k) { v[j + 1] = v[j]; j--; }
    v[j + 1] = k;
  }
  return v[n / 2];
}
int echoUsToMm(long us, float tempC) {
  if (us <= 0) return -1;
  float t = (tempC <= CLIMATE_INVALID + 1.0) ? 20.0 : tempC;
  float mmPerUs = (331.3 + 0.606 * t) / 1000.0;
  return (int)((float)us * mmPerUs / 2.0);
}

int readLightRaw() {
  long sum = 0;
  for (int i = 0; i < 8; i++) { sum += analogRead(LIGHT_PIN); delay(5); }
  return (int)(sum / 8);
}
void readSlowSensors(float *t, float *h, int *rangeMm, long *rangeUs, int *lightRaw) {
  while (millis() < DHT_SETTLE_MS) delay(50);

  *t = dht.readTemperature();
  *h = dht.readHumidity();
  if (isnan(*t) || isnan(*h)) {
    delay(2200);
    *t = dht.readTemperature();
    *h = dht.readHumidity();
  }
  if (fabs(*t) < 0.05 && fabs(*h) < 0.05) {
    Serial.println("[DHT] 0.0/0.0 with a valid checksum - the data line is down");
    *t = NAN;
    *h = NAN;
  }

  if (isnan(*t)) *t = CLIMATE_INVALID;
  if (isnan(*h)) *h = CLIMATE_INVALID;

  *rangeUs  = readEchoMedianUs();
  *rangeMm  = echoUsToMm(*rangeUs, *t);
  *lightRaw = readLightRaw();
}

void sendReading(float t, float h, int soil, int rangeMm, int lightRaw) {
  Serial1.printf("D:%.1f,%.1f,%d,%d,%d\n", t, h, soil, rangeMm, lightRaw);
  Serial.printf("[TX] D:%.1f,%.1f,%d,%d,%d\n", t, h, soil, rangeMm, lightRaw);
}

String awaitCommand(unsigned long timeoutMs) {
  unsigned long start = millis();
  String line = "";
  while (millis() - start < timeoutMs) {
    while (Serial1.available()) {
      char c = Serial1.read();
      if (c == '\n') { line.trim(); return line; }
      if (c != '\r') line += c;
    }
    delay(10);
  }
  line.trim();
  return line;
}

void handleConfig(String payload) {

  payload.remove(0, 2);
  int c1 = payload.indexOf(',');
  int c2 = payload.indexOf(',', c1 + 1);
  int c3 = payload.indexOf(',', c2 + 1);
  if (c1 < 0 || c2 < 0) return;

  int hours  = payload.substring(c1 + 1, c2).toInt();
  int secs   = (c3 > 0) ? payload.substring(c2 + 1, c3).toInt()
                        : payload.substring(c2 + 1).toInt();
  if (hours > 0 && secs > 0) saveConfig(hours, secs);

  if (c3 > 0) {
    time_t epoch = (time_t)payload.substring(c3 + 1).toInt();
    if (epoch > 1700000000) {
      rtcLastContactFromA = epoch;
      rtcClockValid = true;
      Serial.printf("[CFG] clock set from Board A: %ld\n", (long)epoch);
    }
  }
}

#define SPURIOUS_WAKE_LIMIT  3

void goToSleep() {
  digitalWrite(US_TRIG_PIN, LOW);

  bool pinStuck = (rtcSpuriousWakes >= SPURIOUS_WAKE_LIMIT);

  if (pinStuck) {
    Serial.printf("[SLEEP] wake line stuck after %lu attempts - timer only\n",
                  (unsigned long)rtcSpuriousWakes);
  } else {
    Serial.println("[SLEEP] arming ext0 (Board A) and timer wake");
    esp_sleep_enable_ext0_wakeup((gpio_num_t)WAKE_PIN, 1);
  }

  esp_sleep_enable_timer_wakeup(SELF_CHECK_INTERVAL_S * 1000000ULL);
  Serial.flush();
  esp_deep_sleep_start();
}

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600, SERIAL_8N1, 33, 32);
  delay(200);

  Serial1.println("R");
  Serial.println("[TX->A] R (ready)");

  pinMode(WAKE_PIN, INPUT_PULLDOWN);

  pinMode(PUMP_PIN, OUTPUT);
  digitalWrite(PUMP_PIN, HIGH);

  gpio_hold_dis((gpio_num_t)LIGHT_RELAY_PIN);
  pinMode(LIGHT_RELAY_PIN, OUTPUT);
  applyLightState();
  pinMode(US_TRIG_PIN, OUTPUT);
  digitalWrite(US_TRIG_PIN, LOW);
  pinMode(US_ECHO_PIN, INPUT);
  pinMode(LIGHT_PIN, INPUT);

  dht.begin();
  analogReadResolution(12);

  rtcWakeCount++;
  loadConfig();

  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  Serial.printf("\n[WAKE #%u] cause=%d  failsafe threshold=%d%%  timeout=%dh\n",
                rtcWakeCount, (int)cause, FAILSAFE_THRESHOLD_PCT, cfgTimeoutHours);

  int raw = 0;
  int soil  = readSoilPercent(&raw);

  float t = CLIMATE_INVALID, h = CLIMATE_INVALID;
  int   rangeMm = -1, lightRaw = -1;
  long  rangeUs = -1;

  if (cause == ESP_SLEEP_WAKEUP_EXT0) {
    Serial.println("[MODE] pin wake - awaiting command from Board A");

    String cmd = awaitCommand(3000);
    Serial.println("[RX] " + cmd);

    if (cmd.startsWith("C:")) {
      handleConfig(cmd);
      cmd = awaitCommand(3000);
      Serial.println("[RX] " + cmd);
    }

    readSlowSensors(&t, &h, &rangeMm, &rangeUs, &lightRaw);
    Serial.printf("[READ] temp=%.1f hum=%.1f soil=%d%% (raw=%d) range=%dmm (%ldus) light=%d\n",
                  t, h, soil, raw, rangeMm, rangeUs, lightRaw);

    bool validCommand = cmd.startsWith("W:") || cmd.startsWith("C:") ||
                        cmd.startsWith("L:");

    if (validCommand) {
      rtcSilenceSeconds = 0;
      rtcSpuriousWakes  = 0;
      if (rtcClockValid) rtcLastContactFromA = nowEpoch();
      Serial.println("[MODE] valid command - Board A confirmed alive");
    } else {
      rtcSpuriousWakes++;

      rtcSilenceSeconds += (uint32_t)SELF_CHECK_INTERVAL_S;
      rtcElapsedSeconds += (uint32_t)SELF_CHECK_INTERVAL_S;
      Serial.printf("[MODE] no valid command (%lu consecutive) - silence now %lus\n",
                    (unsigned long)rtcSpuriousWakes, (unsigned long)rtcSilenceSeconds);
    }

    sendReading(t, h, soil, rangeMm, lightRaw);

    if (validCommand && cmd.startsWith("L:")) {
      rtcLightOn = (cmd.charAt(2) == '1');
      gpio_hold_dis((gpio_num_t)LIGHT_RELAY_PIN);
      applyLightState();
      Serial1.printf("L:%s\n", rtcLightOn ? "on" : "off");
      Serial.printf("[TX] L:%s\n", rtcLightOn ? "on" : "off");
    }

    if (validCommand && cmd.startsWith("W:1")) {
      bool ok = runPump(cfgPumpSeconds);
      Serial1.printf("P:%s\n", ok ? "ok" : "fail");

      Serial.printf("[TX] P:%s\n", ok ? "ok" : "fail");
      if (ok && rtcClockValid) rtcLastWatered = nowEpoch();
    }

    delay(300);
    goToSleep();
  }

  if (cause == ESP_SLEEP_WAKEUP_TIMER) {
    readSlowSensors(&t, &h, &rangeMm, &rangeUs, &lightRaw);
    Serial.printf("[READ] temp=%.1f hum=%.1f soil=%d%% (raw=%d) range=%dmm (%ldus) light=%d\n",
                  t, h, soil, raw, rangeMm, rangeUs, lightRaw);

    rtcSilenceSeconds += (uint32_t)SELF_CHECK_INTERVAL_S;
    rtcElapsedSeconds += (uint32_t)SELF_CHECK_INTERVAL_S;
    uint32_t timeoutSeconds = (uint32_t)cfgTimeoutHours * 3600UL;

    Serial.printf("[MODE] self-check - silent %lus of %lus before failsafe\n",
                  (unsigned long)rtcSilenceSeconds, (unsigned long)timeoutSeconds);

    if (rtcSilenceSeconds < timeoutSeconds) {
      Serial.println("[MODE] timeout not reached - returning to sleep");
      goToSleep();
    }

    Serial.println("[FAILSAFE] Board A unreachable - operating autonomously");

    rtcSilenceSeconds = 0;

    time_t assumedNow = rtcLastContactFromA + (time_t)rtcElapsedSeconds;

    bool cooldownOk = true;
    if (rtcLastWatered != 0) {
      uint32_t sinceWater = (uint32_t)(assumedNow - rtcLastWatered);
      cooldownOk = sinceWater >= (uint32_t)cfgTimeoutHours * 3600UL;
      Serial.printf("[FAILSAFE] %lus since last watering, cooldown %s\n",
                    (unsigned long)sinceWater, cooldownOk ? "clear" : "ACTIVE");
    }

    if (soil > 2 && soil < FAILSAFE_THRESHOLD_PCT && cooldownOk) {
      Serial.printf("[FAILSAFE] soil %d%% below last-resort threshold %d%% - watering\n",
                    soil, FAILSAFE_THRESHOLD_PCT);
      if (runPump(cfgPumpSeconds)) {
        rtcLastWatered = assumedNow;

        Serial1.printf("F:%d,%ld\n", soil, (long)assumedNow);
      }
    } else if (soil >= FAILSAFE_THRESHOLD_PCT) {
      Serial.printf("[FAILSAFE] soil %d%% at or above last-resort threshold %d%% - no action\n",
                    soil, FAILSAFE_THRESHOLD_PCT);
    }

    goToSleep();
  }

  readSlowSensors(&t, &h, &rangeMm, &rangeUs, &lightRaw);
  Serial.printf("[READ] temp=%.1f hum=%.1f soil=%d%% (raw=%d) range=%dmm (%ldus) light=%d\n",
                t, h, soil, raw, rangeMm, rangeUs, lightRaw);

  Serial.println("[MODE] cold boot");
  rtcSilenceSeconds = 0;
  rtcSpuriousWakes  = 0;
  rtcElapsedSeconds = 0;
  sendReading(t, h, soil, rangeMm, lightRaw);

  delay(300);
  goToSleep();
}

void loop() { }
