
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ---- change these ----
const char* WIFI_SSID    = "YOUR_WIFI_NAME";
const char* WIFI_PASS    = "YOUR_WIFI_PASSWORD";
const char* SERVER_HOST  = "192.168.1.50";   // IP of the computer running the Node server
const uint16_t SERVER_PORT = 5000;
const char* DEVICE_TOKEN = "change-me";      // same as DEVICE_TOKEN in server/.env

// ---- L298N pins ----
const int ENA = 25, IN1 = 26, IN2 = 27;   // left motor
const int ENB = 13, IN3 = 14, IN4 = 12;   // right motor

WebSocketsClient ws;
String wsPath;

char     current = 'S';
bool     timed = false;
uint32_t timedUntil = 0, lastRefresh = 0, lastStatus = 0;
long     timedId = -1;

void drive(char c, int speed) {
  speed = constrain(speed, 0, 255);
  bool lf = false, lb = false, rf = false, rb = false;
  switch (c) {
    case 'F': lf = true; rf = true; break;
    case 'B': lb = true; rb = true; break;
    case 'L': lb = true; rf = true; break;   // spin left in place
    case 'R': lf = true; rb = true; break;   // spin right in place
    default:  speed = 0;
  }
  digitalWrite(IN1, lf); digitalWrite(IN2, lb);
  digitalWrite(IN3, rf); digitalWrite(IN4, rb);
  analogWrite(ENA, speed); analogWrite(ENB, speed);
  current = c;
}

void sendAck(long id) {
  if (id <= 0) return;           // id 0 = manual command, no ack needed
  String out = "{\"type\":\"ack\",\"id\":" + String(id) + "}";
  ws.sendTXT(out);
}

void onMessage(uint8_t* payload, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;
  const char* cmd = doc["cmd"] | "S";
  long id = doc["id"] | 0;
  int ms = doc["ms"] | 0;
  int speed = doc["speed"] | 180;

  if (cmd[0] == 'S') {
    drive('S', 0);
    timed = false;
    sendAck(id);
    return;
  }
  drive(cmd[0], speed);
  if (ms > 0) {                  // timed step used by the route runner
    timed = true;
    timedUntil = millis() + ms;
    timedId = id;
  } else {                       // manual drive: must be refreshed every <500 ms
    timed = false;
    lastRefresh = millis();
    sendAck(id);
  }
}

void onEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("Server connected");
      break;
    case WStype_DISCONNECTED:
      Serial.println("Server disconnected, motors stopped");
      drive('S', 0); timed = false;
      break;
    case WStype_TEXT:
      onMessage(payload, length);
      break;
    default: break;
  }
}

void setup() {
  Serial.begin(115200);
  int pins[] = {ENA, IN1, IN2, ENB, IN3, IN4};
  for (int p : pins) pinMode(p, OUTPUT);
  drive('S', 0);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.print("\nESP32 IP: "); Serial.println(WiFi.localIP());

  wsPath = String("/esp?token=") + DEVICE_TOKEN;
  ws.begin(SERVER_HOST, SERVER_PORT, wsPath.c_str());
  ws.onEvent(onEvent);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(15000, 3000, 2);
}

void loop() {
  ws.loop();

  // finish a timed step and confirm it to the server
  if (timed && (int32_t)(millis() - timedUntil) >= 0) {
    drive('S', 0);
    timed = false;
    sendAck(timedId);
  }
  // failsafe: manual command stops if the browser stops refreshing it
  if (!timed && current != 'S' && millis() - lastRefresh > 500) drive('S', 0);

  // keep the Wi-Fi alive and report signal strength
  if (WiFi.status() != WL_CONNECTED) { drive('S', 0); WiFi.reconnect(); }
  if (millis() - lastStatus > 3000 && ws.isConnected()) {
    lastStatus = millis();
    String out = "{\"type\":\"status\",\"rssi\":" + String(WiFi.RSSI()) + "}";
    ws.sendTXT(out);
  }
}
