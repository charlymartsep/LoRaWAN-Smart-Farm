const mqtt = require('mqtt');

// TTN application API key (starts with NNSXS.), NOT the AppKey of a node.
// Create it in TTN: Applications > lorawan-tfg > API keys, with the rights
// "Read application traffic" and "Write downlink application traffic".
const API_KEY  = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
if (!API_KEY.startsWith('NNSXS.')) {
  console.error('ERROR: API_KEY is not a TTN API key (it must start with NNSXS.)');
  process.exit(1);
}
// --- Watering thresholds from FAO-56 water balance, section 3.4.2 ---
const FC_READING    = 50;    // [X] soil % at field capacity, in situ
const WP_FC_RATIO   = 0.44;  // wilting point / field capacity, loam
const REFILL_MARGIN = 0.10;  // stop at 90 % of the available water
const DEPLETION_P = {        // FAO-56 Table 22, depletion without stress
  lettuce: 0.30, pepper: 0.30, tomato: 0.40, melon: 0.40,
  cabbage: 0.45, broccoli: 0.45, zucchini: 0.50, cucumber: 0.50,
};
const CROPS = ['lettuce', 'pepper', 'tomato', 'cabbage', 'zucchini'];
const P_ZONE = Math.min(...CROPS.map((c) => DEPLETION_P[c]));
const AVAILABLE = FC_READING * (1 - WP_FC_RATIO);
const DRY_THRESHOLD = Math.round(FC_READING - P_ZONE * AVAILABLE);
const WET_THRESHOLD = Math.round(FC_READING - REFILL_MARGIN * AVAILABLE);
const DRY_IS_LOW_VALUE = true;

const APP_ID   = 'lorawan-tfg';
const VALVE_ID = 'valvula-lilygo';
const CLUSTER  = 'eu1.cloud.thethings.network';

const WATERING_MINUTES = 10;
const WAIT_AFTER_WATERING = 60;   // minutes
const MAX_ORDERS_PER_DAY = 6;

// ---------- TTN CONNECTION ----------
const TOPIC_TTN = `v3/${APP_ID}@ttn/devices/+/up`;
const clientTTN = mqtt.connect(`mqtts://${CLUSTER}:8883`, {
  username: `${APP_ID}@ttn`,
  password: API_KEY,
});

// ---------- LOCAL MQTT ----------
const TOPIC_LOCAL = 'tfg/garden/sensors';
const TOPIC_VALVE = 'tfg/garden/valve';
const clientLocal = mqtt.connect('mqtt://localhost:1883');

// ---------- LATEST SENSOR VALUES ----------
let realWind = 0.0;
let realSoilMoisture = 0.0;
let realRain = 0.0;
let realAmbientTemp = 0.0;
let realAmbientHum = 0.0;
let realPressure = 0.0;

// ---------- WATERING STATE ----------
let lastOrder = 0;
let wateringUntil = 0;
let ordersToday = 0;
let currentDay = new Date().toDateString();

// ---------- PERFORMANCE STATISTICS ----------
let uplinksReceived = 0;
let firstUplinkTime = null;
let lastUplinkTime = null;

// ---------- UPLINK COUNTER STATISTICS ----------
let lastCounter = null;
let receivedPackets = 0;
let lostPackets = 0;
let rebootCount = 0;

clientTTN.on('connect', () => {
  console.log('Connected to The Things Network cloud.');
  clientTTN.subscribe(TOPIC_TTN);
});

clientTTN.on('error', (err) => {
  console.error('TTN MQTT error (check API_KEY):', err.message);
});

clientTTN.on('message', async (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const deviceId = data.end_device_ids?.device_id;
    const p = data.uplink_message?.decoded_payload;

    // --- Valve heartbeat: store its status, never trigger watering logic ---
    if (deviceId === VALVE_ID) {
      if (p && typeof p.valve_open === 'boolean') {
        const valvePayload = {
          device: VALVE_ID,
          valve_open: p.valve_open ? 1 : 0,
          valve_minutes_left: p.valve_minutes_left ?? 0,
        };
        clientLocal.publish(TOPIC_VALVE, JSON.stringify(valvePayload));
        console.log(
          `[VALVE ${deviceId}] open=${valvePayload.valve_open} minutes_left=${valvePayload.valve_minutes_left}`
        );
      }
      return;
    }

    if (!p || typeof p.uplink_counter !== 'number') return;

    // --- System performance validation ---
    uplinksReceived++;
    const now = new Date();
    if (firstUplinkTime === null) firstUplinkTime = now;
    lastUplinkTime = now;
    console.log(`[UPLINK #${uplinksReceived}] ${deviceId} - ${now.toISOString()}`);

    // --- Uplink counter analysis (packet loss and reboots) ---
    if (typeof p.uplink_counter === 'number') {
      const c = p.uplink_counter;
      receivedPackets++;

      if (lastCounter === null) {
        console.log(`First counter received: #${c}`);
      } else if (c === lastCounter + 1) {
        // Correct sequence
      } else if (c > lastCounter + 1) {
        const missed = c - lastCounter - 1;
        lostPackets += missed;
        console.warn(`!!! ${missed} packet(s) lost between #${lastCounter} and #${c}`);
      } else {
        rebootCount++;
        console.warn(`!!! REBOOT detected: counter ${lastCounter} -> ${c}`);
        if (c > 1) lostPackets += c - 1;
      }
      lastCounter = c;

      console.log(
        `[STATS] received=${receivedPackets} lost=${lostPackets} reboots=${rebootCount}`
      );
    }

    // --- Sensor values ---
    realWind = p.wind_speed ?? 0.0;
    realRain = p.accumulated_rain ?? 0.0;
    realAmbientTemp = p.ambient_temperature ?? 0.0;
    realAmbientHum = p.ambient_humidity ?? 0.0;
    realPressure = p.atmospheric_pressure ?? 0.0;

    console.log(
      `[TTN ${deviceId}] Wind: ${realWind} | Soil: ${p.soil_moisture} | Rain: ${realRain} | ` +
      `Temp: ${realAmbientTemp} | EnvHum: ${realAmbientHum} | Pressure: ${realPressure}`
    );

    if (typeof p.soil_moisture === 'number') {
      realSoilMoisture = p.soil_moisture;
      await decideWatering(p.soil_moisture);
    }
  } catch (error) {
    console.error('Error reading TTN message:', error);
  }
});

// ---------- WATERING LOGIC (unchanged) ----------
async function decideWatering(moisture) {
  if (moisture <= 0) {
    console.log('Moisture reading 0: discarded');
    return;
  }

  if (new Date().toDateString() !== currentDay) {
    currentDay = new Date().toDateString();
    ordersToday = 0;
  }

  const now = Date.now();

  if (now < wateringUntil && moisture >= WET_THRESHOLD) {
    console.log(`Wet soil (${moisture} >= ${WET_THRESHOLD}): sending close order`);
    if (await sendOrder([0x00])) {
      wateringUntil = 0;
      ordersToday++;
    }
    return;
  }

  const isDry = DRY_IS_LOW_VALUE ? moisture < DRY_THRESHOLD : moisture > DRY_THRESHOLD;
  if (!isDry) return;
  if (now - lastOrder < WAIT_AFTER_WATERING * 60000) return;
  if (ordersToday >= MAX_ORDERS_PER_DAY) {
    console.log('Daily order limit reached');
    return;
  }

  console.log(`Dry soil (${moisture}, threshold ${DRY_THRESHOLD}): sending watering order`);
  if (await openValve(WATERING_MINUTES)) {
    lastOrder = now;
    wateringUntil = now + (WATERING_MINUTES + 12) * 60000;
    ordersToday++;
  }
}

// ---------- WATERING TIME WINDOW ----------
const WATERING_WINDOW_ENABLED = true;   // set to false for tests
const WATERING_START_HOUR = 19;          // watering allowed from 19:00
const WATERING_END_HOUR = 7;             // until 07:00

function isWateringAllowed() {
  if (!WATERING_WINDOW_ENABLED) return true;
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Europe/Madrid'
  }).format(new Date()));
  return hour >= WATERING_START_HOUR || hour < WATERING_END_HOUR;
}

async function openValve(minutes) {
  if (!isWateringAllowed()) {
    console.log('Watering blocked: outside the allowed window 19:00-07:00');
    return false;
  }
  return sendOrder([0x01, minutes]);
}

async function sendOrder(bytes) {
  const url = `https://${CLUSTER}/api/v3/as/applications/${APP_ID}/devices/${VALVE_ID}/down/replace`;
  const body = {
    downlinks: [{
      f_port: 1,
      frm_payload: Buffer.from(bytes).toString('base64'),
      priority: 'NORMAL',
    }],
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      console.log(`>>> Order queued: ${Buffer.from(bytes).toString('hex')}`);
      return true;
    }
    console.error(`Error ${r.status}: ${await r.text()}`);
  } catch (e) {
    console.error('Error sending downlink:', e);
  }
  return false;
}

// ---------- PERIODIC PUBLISH TOWARDS INFLUXDB BRIDGE / GRAFANA ----------
clientLocal.on('connect', () => {
  console.log('MASNOU Station online. Publishing data to Grafana...');

  setInterval(() => {
    const payload = {
      node: 'Masnou_Garden',
      wind_speed: realWind,
      soil_moisture: realSoilMoisture,
      accumulated_rain: realRain,
      ambient_temperature: realAmbientTemp,
      ambient_humidity: realAmbientHum,
      atmospheric_pressure: realPressure,
      uplink_counter: lastCounter ?? 0,
      received_packets: receivedPackets,
      lost_packets: lostPackets,
      reboot_count: rebootCount,
    };
    clientLocal.publish(TOPIC_LOCAL, JSON.stringify(payload));
  }, 5000);
});
