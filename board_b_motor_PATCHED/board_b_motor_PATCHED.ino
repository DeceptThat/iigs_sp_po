
#include <Arduino.h>
#include <Stepper.h>
#include <Preferences.h>

// ---------------- pins ----------------
#define IN1 5
#define IN2 18
#define IN3 19
#define IN4 21

#define BOARDA_RX_PIN 26
#define BOARDA_TX_PIN 25

// ---------------- stepper ----------------
// 28BYJ-48 through a ULN2003. 2048 steps per revolution in half-step mode.
const int STEPS_PER_REV = 2048;
// FOUR, which is what the hardware has actually been running.
//
// The motor log is the evidence: 278 completed moves across six angles, every
// median duration matching 4 rpm to within 25 ms. A 28BYJ-48 through a ULN2003
// will turn faster than this, but torque falls as speed rises and there is no
// encoder on this mount - a skipped step is position lost silently and for
// good. Four is also the configuration under which 59 sweeps completed.
const int STEPPER_RPM   = 4;
const int NUDGE_RPM     = 2;    // slower still, for corrective movements

// The Stepper library expects the ULN2003 inputs in the order IN1, IN3,
// IN2, IN4. Wiring them in numeric order produces vibration without
// rotation, which is the usual symptom of this mistake.
Stepper motor(STEPS_PER_REV, IN1, IN3, IN2, IN4);

// "crashLog" rather than "log": the latter collides with log() from math.h
// and produces a confusing compile error.
Preferences crashLog;

HardwareSerial BoardALink(1);

int  currentPositionDeg = 0;
// False when the stored position cannot be trusted: set after power was
// lost during a movement, and cleared only by an explicit re-zero.
bool positionKnown      = true;
long movesCompleted     = 0;
long boardABootsSeen    = 0;
long ownBoots           = 0;

String incoming = "";

// Rejects anything outside a sensible range so a malformed message cannot
// drive the mount into its end stop.
const int MAX_SINGLE_MOVE_DEG = 360;

bool performMove(int degrees) {
  if (degrees == 0) {
    Serial.println("[MOTOR] rejected: zero is not a movement");
    return false;
  }

  // A sweep drives to absolute angles reckoned from the stored position. If
  // that position is not trustworthy the sweep would point the camera at the
  // wrong things and record the wrong angle against each frame, which is
  // worse than not sweeping at all.
  if (!positionKnown) {
    Serial.println("[MOTOR] rejected: position unknown, re-zero with ZERO first");
    return false;
  }
  if (abs(degrees) > MAX_SINGLE_MOVE_DEG) {
    Serial.printf("[MOTOR] rejected %d deg: exceeds single-move limit\n", degrees);
    return false;
  }

  long steps = (long)STEPS_PER_REV * degrees / 360L;   // sign carries through
  Serial.printf("[MOTOR] %+d deg = %ld steps\n", degrees, steps);

  // Record that a movement is beginning, before it begins.
  //
  // Position here is an accumulated step count, not a measurement: there is
  // no encoder and no limit switch, so the stored angle means only "where we
  // believe we put it". Power lost part way through a move leaves the mount
  // at an angle nobody knows, and without this flag the board would reboot
  // believing it is where it was before the move, and every later sweep
  // would be silently skewed by the lost fraction.
  //
  // The flag does not recover the position. Nothing can, without a physical
  // reference. It marks the stored value as untrustworthy so an operator is
  // told rather than misled.
  crashLog.putBool("moving", true);

  // Stepping is blocking, which is precisely why it lives on this board and
  // not on the one holding the network connection.
  motor.step(steps);

  // De-energise the coils. Left energised they draw current continuously and
  // heat both the motor and the driver for no benefit while stationary.
  digitalWrite(IN1, LOW); digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW); digitalWrite(IN4, LOW);

  currentPositionDeg = (currentPositionDeg + degrees) % 360;
  if (currentPositionDeg < 0) currentPositionDeg += 360;

  movesCompleted++;
  crashLog.putLong("moves", movesCompleted);
  crashLog.putInt("position", currentPositionDeg);
  crashLog.putBool("moving", false);      // the move completed intact

  Serial.printf("[MOTOR] complete, position now %d deg\n", currentPositionDeg);
  return true;
}

// Moves the mount without touching the tracked position.
//
// A nudge is a physical correction, not a commanded movement. It is the tool
// for putting the camera back where it belongs after a slip, a knock, or an
// interrupted move, and it deliberately does three things differently from
// performMove():
//
//   It bypasses the position guard, because an unknown position is exactly
//   when realignment is needed and refusing to move would leave no way out
//   except turning the mount by hand against the gearbox.
//
//   It does not update currentPositionDeg. Nudging back to where centre
//   ought to be would otherwise leave the count reading some arbitrary
//   angle when the mount is visibly at centre. ZERO is what reconciles the
//   count with reality, and it is a separate, deliberate act.
//
//   It steps at a lower speed, since these are small corrective movements
//   made while watching, and a slower step is less likely to slip under the
//   load of a mounted camera.
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

    // Let the electrical transients settle before speaking.
    //
    // The coils are inductive and the driver switches them hard. Replying
    // immediately put the acknowledgement on the wire while the line was
    // still ringing, and Board A received corrupted bytes rather than the
    // message. A ninety degree move suffered worse than a forty-five, being
    // twice as long, which is why the routine sweep failed every time while
    // the shorter check sweep usually succeeded.
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

  // Nudge: N1, N5, N10 and their negatives. Any value up to 30 degrees is
  // accepted, so N3 or N-12 work as well as the round numbers.
  if (line.length() > 1 && (line[0] == 'N' || line[0] == 'n')) {
    int deg = line.substring(1).toInt();
    bool ok = performNudge(deg);
    BoardALink.printf("N:%s,%d\n", ok ? "ok" : "fail", deg);
    return;
  }

  // HOME - drive back to the reference angle.
  //
  // Board A has been sending this since the first sweep and nothing here
  // answered it: after a failed sweep, after a manual nudge, and from the
  // console, the mount was told to come home and simply did not, while Board A
  // waited out its twenty-second timeout and then assumed the move had
  // happened. The reply matters as much as the movement - without an M: line
  // the controller cannot tell a mount that came home from one that ignored it.
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
    // Shortest way round. The stored angle is normalised to 0..359, so a
    // mount at 300 deg comes home by +60 rather than by -300.
    int back = -currentPositionDeg;
    while (back >  180) back -= 360;
    while (back < -180) back += 360;
    Serial.printf("[MOTOR] homing from %d deg by %+d\n", currentPositionDeg, back);
    bool ok = performMove(back);
    BoardALink.printf("M:%s,%d\n", ok ? "ok" : "fail", currentPositionDeg);
    return;
  }

  // RESUME and STOP are accepted so the console's full command set is answered
  // rather than silently dropped. There is no motion thread to interrupt - a
  // move runs to completion inside performMove - so STOP reports the position
  // it finds rather than claiming to have halted something.
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
    // Declares the current physical position to be the reference. Aim the
    // mount by hand first; this sets the count, it does not move anything.
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
  // From Board A.
  while (BoardALink.available()) {
    char c = BoardALink.read();
    if (c == '\n') { handleLine(incoming); incoming = ""; }
    else if (c != '\r') incoming += c;
  }

  // From the USB serial monitor, so the board can be exercised on its own.
  static String usbLine = "";
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { handleLine(usbLine); usbLine = ""; }
    else if (c != '\r') usbLine += c;
  }

  delay(10);
}
