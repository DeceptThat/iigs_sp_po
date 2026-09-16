/*
  BOARD B — crashHandler (Motor Control + System Crash/Works Log)
  -----------------------------------------------------------------------
  Purpose: own the stepper motor AND act as the system's persistent
  "black box" — logging both its own boot count and how often Board A
  (the Firebase board) has to reboot, via a one-time "BOOT" message
  Board A sends over UART right after it starts.

  This board NEVER touches Wi-Fi or Firebase, which means it is
  structurally immune to the SSL hang that's been affecting Board A —
  it simply has no code path that could get stuck in a TLS handshake.

  Wired UART link to Board A, pins 25/26 (crossed):
    crashHandler RX(26) <- Board A TX(25)
    crashHandler TX(25) -> Board A RX(26)

  Motor pins moved here from the old combined master board — same pins,
  now free since Board A no longer drives the motor directly.
*/

#include <Arduino.h>
#include <Preferences.h>
#include <Stepper.h>

// ---------- Serial link to Board A (pins 25/26, crossed) ----------
#define BOARDA_RX_PIN 26
#define BOARDA_TX_PIN 25
HardwareSerial BoardALink(1); // UART1

String incomingLine = "";

// ---------- Persistent crash/works log ----------
// Named "crashLog" (not "log") to avoid clashing with the built-in
// math library's log() function, which caused a compile error.
Preferences crashLog;
unsigned int crashHandlerBoots = 0;   // how many times THIS board has booted
unsigned int boardARebootsSeen = 0;   // how many "BOOT" messages received from Board A
unsigned int motorMovesCompleted = 0; // successful motor commands executed

// ---------- Stepper motor (moved here from Board A) ----------
class ValveMotor {
  private:
    Stepper* stepper;
    long pendingSteps = 0;
    uint8_t pin1, pin2, pin3, pin4;

  public:
    ValveMotor(int stepsPerRev, uint8_t p1, uint8_t p2, uint8_t p3, uint8_t p4) {
      pin1 = p1; pin2 = p2; pin3 = p3; pin4 = p4;
      stepper = new Stepper(stepsPerRev, pin1, pin3, pin2, pin4);
    }

    void begin(int speed) {
      stepper->setSpeed(speed);
      powerOff();
    }

    void powerOff() {
      digitalWrite(pin1, LOW);
      digitalWrite(pin2, LOW);
      digitalWrite(pin3, LOW);
      digitalWrite(pin4, LOW);
    }

    void setTargetAngle(int angle) {
      pendingSteps = (angle * 2048L) / 360L;
    }

    bool isMoving() {
      return pendingSteps != 0;
    }

    bool update() {
      if (pendingSteps != 0) {
        long stepsThisLoop = (pendingSteps > 0) ? min(20L, pendingSteps) : max(-20L, pendingSteps);

        stepper->step(stepsThisLoop);
        pendingSteps -= stepsThisLoop;

        yield();
        delay(5);

        if (pendingSteps == 0) {
          powerOff();
          Serial.println("-> Motor: Movement complete!");
          return true;
        }
      }
      return false;
    }
};

ValveMotor motor(2048, 5, 18, 19, 21);

void handleIncomingLine(String line) {
  if (line == "BOOT") {
    boardARebootsSeen++;
    crashLog.putUInt("boardA_reboots", boardARebootsSeen);
    Serial.printf("Board A rebooted. Total seen: %d\n", boardARebootsSeen);
  } else if (line.startsWith("MOTOR:")) {
    int angle = line.substring(6).toInt();
    Serial.printf("Motor command received: %d degrees\n", angle);
    motor.setTargetAngle(angle);
  }
}

void checkBoardALink() {
  while (BoardALink.available()) {
    char c = BoardALink.read();
    if (c == '\n') {
      incomingLine.trim();
      if (incomingLine.length() > 0) {
        handleIncomingLine(incomingLine);
      }
      incomingLine = "";
    } else {
      incomingLine += c;
    }
  }
}

// TEST-ONLY: lets you type commands directly into Arduino's Serial Monitor
// (the USB one, not BoardALink) to simulate what Board A would send —
// so you can test crashHandler fully standalone before Board A is wired up.
// Type "MOTOR:90" or "BOOT" into the Serial Monitor input box and press Enter.
void checkTestInput() {
  if (Serial.available()) {
    String testLine = Serial.readStringUntil('\n');
    testLine.trim();
    if (testLine.length() > 0) {
      Serial.println("[TEST INPUT] Simulating: " + testLine);
      handleIncomingLine(testLine);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  BoardALink.begin(9600, SERIAL_8N1, BOARDA_RX_PIN, BOARDA_TX_PIN);

  crashLog.begin("crashlog", false);
  crashHandlerBoots = crashLog.getUInt("crashHandler_boots", 0);
  boardARebootsSeen = crashLog.getUInt("boardA_reboots", 0);
  motorMovesCompleted = crashLog.getUInt("motor_moves", 0);

  crashHandlerBoots++;
  crashLog.putUInt("crashHandler_boots", crashHandlerBoots);

  motor.begin(10); // RPM

  Serial.println("crashHandler ready.");
  Serial.printf("Log so far — crashHandler boots: %d | Board A reboots seen: %d | Motor moves completed: %d\n",
                 crashHandlerBoots, boardARebootsSeen, motorMovesCompleted);
}

void loop() {
  checkBoardALink();
  checkTestInput(); // remove this line once Board A is wired up and tested for real

  if (motor.update()) {
    motorMovesCompleted++;
    crashLog.putUInt("motor_moves", motorMovesCompleted);
  }
}
