const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const mqtt = require('mqtt');

const url = 'http://localhost:8181';
const token = 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; 
const org = 'default';
const bucket = 'smart_farm_tfg';

const influxDB = new InfluxDB({ url, token });
const writeApi = influxDB.getWriteApi(org, bucket);

const mqttClient = mqtt.connect('mqtt://localhost:1883');
const TOPIC_SENSORS = 'tfg/garden/sensors';
const TOPIC_VALVE = 'tfg/garden/valve';

const safeFloat = (val) => {
  const num = parseFloat(val);
  return isNaN(num) ? 0.0 : num;
};

console.log('BRIDGE SERVER: Listening and saving to InfluxDB');

mqttClient.on('connect', () => {
  console.log('Connected to MQTT Broker. Waiting for data...');
  mqttClient.subscribe([TOPIC_SENSORS, TOPIC_VALVE]);
});

mqttClient.on('message', (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    const time = new Date().toLocaleTimeString();

    if (topic === TOPIC_VALVE) {
      const point = new Point('valve_status')
        .tag('device', data.device || 'unknown')
        .floatField('valve_open', safeFloat(data.valve_open))
        .floatField('valve_minutes_left', safeFloat(data.valve_minutes_left));

      writeApi.writePoint(point);
      console.log(`[${time}] VALVE heartbeat -> Saved to InfluxDB (valve_status).`);
      return;
    }

    if (topic === TOPIC_SENSORS) {
      const point = new Point('general_weather')
        .tag('node', data.node || 'unknown')
        .floatField('soil_moisture', safeFloat(data.soil_moisture))
        .floatField('ambient_temperature', safeFloat(data.ambient_temperature))
        .floatField('ambient_humidity', safeFloat(data.ambient_humidity))
        .floatField('atmospheric_pressure', safeFloat(data.atmospheric_pressure))
        .floatField('wind_speed', safeFloat(data.wind_speed))
        .floatField('accumulated_rain', safeFloat(data.accumulated_rain))
        .floatField('uplink_counter', safeFloat(data.uplink_counter))
        .floatField('received_packets', safeFloat(data.received_packets))
        .floatField('lost_packets', safeFloat(data.lost_packets))
        .floatField('reboot_count', safeFloat(data.reboot_count));

      writeApi.writePoint(point);
      console.log(`[${time}] RECEIVED from: ${data.node || 'unknown_node'} -> Saved to InfluxDB.`);
    }
  } catch (e) {
    console.error('Error processing JSON:', e);
  }
});

process.on('SIGINT', async () => {
  try {
    await writeApi.close();
  } catch (e) {
    console.error('Error closing InfluxDB writer:', e);
  }
  process.exit(0);
});