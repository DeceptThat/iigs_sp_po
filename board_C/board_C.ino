#include <DHT.h>

// Sensor Pins
#define DHTPIN 16
#define DHTTYPE DHT22
#define SOIL_PIN 34
#define WAKE_PIN 4

// UART Pins communicating with Master
#define RX_PIN 33
#define TX_PIN 32

// Relay Module Pin (Active-Low configuration)
#define RELAY_PIN 26

DHT dht(DHTPIN, DHTTYPE);
HardwareSerial MasterSerial(1); 

void setup() {
  Serial.begin(115200);
  MasterSerial.begin(9600, SERIAL_8N1, RX_PIN, TX_PIN); 
  
  
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, HIGH); 

  // ---- NEW LINE (fix) ----
  // Pull WAKE_PIN HIGH by default using the ESP32's internal resistor,
  // so the level-triggered deep sleep wakeup doesn't fire on a floating
  // or noisy pin. Without this, the pin has no defined voltage when
  // nothing is actively driving it, which can cause an instant
  // wake-sleep-wake crash loop.
  pinMode(WAKE_PIN, INPUT_PULLUP);
  // ---- END NEW LINE ----

  Serial.println("\n[SENSOR BOARD WOKE UP]");

  bool shouldWater = false;
  unsigned long waitStartTime = millis();
  
 
  Serial.println("Waiting for Master command...");
  while (millis() - waitStartTime < 5000) { 
    if (MasterSerial.available()) {
      String cmd = MasterSerial.readStringUntil('\n');
      cmd.trim();
      Serial.println("Received from Master: " + cmd);
      if (cmd == "W:1") {
        shouldWater = true;
      }
      break; 
    }
    delay(10); // ---- NEW LINE (fix) ---- yields to the watchdog so this
               // wait loop can't trip a watchdog reset on its own
  }


  dht.begin();
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  
  if (isnan(h) || isnan(t)) {
    Serial.println("Failed to read from DHT sensor!");
    h = 0.0;
    t = 0.0;
  }
  
  int soilRaw = analogRead(SOIL_PIN);
  int soilPercent = map(soilRaw, 4095, 1500, 0, 100);
  soilPercent = constrain(soilPercent, 0, 100);


  MasterSerial.printf("D:%.1f,%.1f,%d\n", t, h, soilPercent);
  Serial.printf("Sent Data -> Temp: %.1f | Hum: %.1f | Soil: %d\n", t, h, soilPercent);

 
  if (shouldWater) {
    Serial.println("WATER COMMAND ACTIVE! Turning ON relay...");
    
    digitalWrite(RELAY_PIN, LOW);  
    delay(5000);                   
    
    Serial.println("Turning OFF relay...");
    digitalWrite(RELAY_PIN, HIGH); 
    
    Serial.println("Watering complete.");
  }


  Serial.println("Going to Deep Sleep.");
  esp_sleep_enable_ext0_wakeup((gpio_num_t)WAKE_PIN, 0); 
  esp_deep_sleep_start();
}

void loop(){

}