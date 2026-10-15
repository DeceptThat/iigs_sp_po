#include <Arduino.h>
#include <Stepper.h>
#include <Preferences.h>

#define IN1 5
#define IN2 18
#define IN3 19
#define IN4 21

#define BOARDA_RX_PIN 26
#define BOARDA_TX_PIN 25

const int STEPS_PER_REV = 2048;

const int STEPPER_RPM   = 4;
const int NUDGE_RPM     = 2;

Stepper motor(STEPS_PER_REV, IN1, IN3, IN2, IN4);

Preferences crashLog;

HardwareSerial BoardALink(1);

int  currentPositionDeg = 0;

bool positionKnown      = true;
long movesCompleted     = 0;
long boardABootsSeen    = 0;
long ownBoots           = 0;

String incoming = "";

const int MAX_SINGLE_MOVE_DEG = 360;

bool performMove(int degrees) {
  if (degrees == 0) {
    Serial.println("[MOTOR] rejected: zero is not a movement");
    return false;
  }

  if (!positionKnown) {
    Serial.println("[MOTOR] rejected: position unknown, re-zero with ZERO first");
    return false;
  }
  if (abs(degrees) > MAX_SINGLE_MOVE_DEG) {
    Serial.printf("[MOTOR] rejected %d deg: exceeds single-move limit\n", degrees);
    return false;
  }

  long steps = (long)STEPS_PER_REV * degrees / 360L;
  Serial.printf("[MOTOR] %+d deg = %ld steps\n", degrees, steps);

  crashLog.putBool("moving", true);

  motor.step(steps);

  digitalWrite(IN1, LOW); digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW); digitalWrite(IN4, LOW);

  currentPositionDeg = (currentPositionDeg + degrees) % 360;
  if (currentPositionDeg < 0) currentPositionDeg += 360;

  movesCompleted++;
  crashLog.putLong("moves", movesCompleted);
  crashLog.putInt("position", currentPositionDeg);
  crashLog.putBool("moving", false);

  Serial.printf("[MOTOR] complete, position now %d deg\n", currentPositionDeg);
  return true;
}

bool performNudge(int degrees) {
  if (degrees == 0) return false;
  if (abs(degrees) > 30) {
    Serial.println("[NUDGE] rejected: use MOTOR: for movements above 30 deg");
    return false;
  }

  long steps = (long)STEPS_PER_REV * degrees / 360L;
  Serial.printf("[NUDGE] %+d deg = %ld steps (position count unchanged)\n",
                degrees, steps);

  motor.setSpeed(NUDGE_RPM);
  motor.step(steps);
  motor.setSpeed(STEPPER_RPM);

  digitalWrite(IN1, LOW); digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW); digitalWrite(IN4, LOW);

  Serial.println("[NUDGE] done. Type ZERO when the mount is where centre should be.");
  return true;
}

void handleLine(String line) {
  line.trim();
  if (line.length() == 0) return;
  Serial.println("[RX] " + line);

  if (line.startsWith("MOTOR:")) {
    int degrees = line.substring(6).toInt();
    bool ok = performMove(degrees);

    delay(150);

    BoardALink.printf("M:%s,%d\n", ok ? "ok" : "fail", degrees);
    Serial.printf("[TX] M:%s,%d\n", ok ? "ok" : "fail", degrees);
    return;
  }

  if (line.startsWith("BOOT")) {
    boardABootsSeen++;
    crashLog.putLong("aboots", boardABootsSeen);
    Serial.printf("[LOG] Board A restart #%ld recorded\n", boardABootsSeen);
    return;
  }

  if (line.length() > 1 && (line[0] == 'N' || line[0] == 'n')) {
    int deg = line.substring(1).toInt();
    bool ok = performNudge(deg);
    BoardALink.printf("N:%s,%d\n", ok ? "ok" : "fail", deg);
    return;
  }

  if (line.startsWith("HOME")) {
    if (!positionKnown) {
      Serial.println("[MOTOR] HOME refused: position unknown, ZERO it first");
      BoardALink.printf("M:fail,%d\n", currentPositionDeg);
      return;
    }
    if (currentPositionDeg == 0) {
      Serial.println("[MOTOR] already at the reference angle");
      BoardALink.println("M:ok,0");
      return;
    }

    int back = -currentPositionDeg;
    while (back >  180) back -= 360;
    while (back < -180) back += 360;
    Serial.printf("[MOTOR] homing from %d deg by %+d\n", currentPositionDeg, back);
    bool ok = performMove(back);
    BoardALink.printf("M:%s,%d\n", ok ? "ok" : "fail", currentPositionDeg);
    return;
  }

  if (line.startsWith("STOP")) {
    Serial.println("[MOTOR] stop acknowledged; no movement is in flight");
    BoardALink.printf("M:ok,%d\n", currentPositionDeg);
    return;
  }

  if (line.startsWith("RESUME")) {
    Serial.println("[MOTOR] resume: nothing was suspended");
    BoardALink.printf("M:ok,%d\n", currentPositionDeg);
    return;
  }

  if (line.startsWith("ZERO")) {

    currentPositionDeg = 0;
    positionKnown = true;
    crashLog.putInt("position", 0);
    crashLog.putBool("moving", false);
    Serial.println("[MOTOR] position reference set to current angle");
    BoardALink.println("Z:ok");
    return;
  }

  if (line.startsWith("STATUS")) {
    BoardALink.printf("S:%d,%ld,%ld,%ld,%d\n",
                      currentPositionDeg, movesCompleted, boardABootsSeen, ownBoots,
                      positionKnown ? 1 : 0);
    return;
  }
}

void setup() {
  Serial.begin(115200);
  BoardALink.begin(9600, SERIAL_8N1, BOARDA_RX_PIN, BOARDA_TX_PIN);
  delay(300);

  pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  digitalWrite(IN1, LOW); digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW); digitalWrite(IN4, LOW);

  motor.setSpeed(STEPPER_RPM);

  crashLog.begin("crashlog", false);
  ownBoots         = crashLog.getLong("bboots", 0) + 1;
  movesCompleted   = crashLog.getLong("moves", 0);
  boardABootsSeen  = crashLog.getLong("aboots", 0);
  currentPositionDeg = crashLog.getInt("position", 0);
  positionKnown      = !crashLog.getBool("moving", false);
  crashLog.putLong("bboots", ownBoots);

  Serial.println("\n===== BOARD B: MOTOR AND LOGGING =====");
  Serial.printf("own boots        : %ld\n", ownBoots);
  Serial.printf("Board A restarts : %ld\n", boardABootsSeen);
  Serial.printf("moves completed  : %ld\n", movesCompleted);
  Serial.printf("position         : %d deg\n", currentPositionDeg);

  if (!positionKnown) {
    Serial.println();
    Serial.println("*** POSITION UNKNOWN ***");
    Serial.println("*** Power was lost during a movement, so the stored angle is");
    Serial.println("*** not where the mount actually is. Aim it by hand, then");
    Serial.println("*** type ZERO to set the reference. Commanded movement is");
    Serial.println("*** refused until then, but N1 / N5 / N10 still work for");
    Serial.println("*** realigning by hand.");
    Serial.println();
  }

  Serial.println("Commands:");
  Serial.println("  MOTOR:90 / MOTOR:-45   commanded movement, updates the position count");
  Serial.println("  N1 N5 N10 N-1 N-5 ...  nudge, corrective, count unchanged");
  Serial.println("  HOME                   drive back to the reference angle");
  Serial.println("  ZERO                   declare the current angle to be centre");
  Serial.println("  STATUS                 report counters and position");
}

void loop() {

  while (BoardALink.available()) {
    char c = BoardALink.read();
    if (c == '\n') { handleLine(incoming); incoming = ""; }
    else if (c != '\r') incoming += c;
  }

  static String usbLine = "";
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { handleLine(usbLine); usbLine = ""; }
    else if (c != '\r') usbLine += c;
  }

  delay(10);
}
