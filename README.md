# LoRaWAN Smart Irrigation System 🌱

> **BSc Thesis Project:** Autonomous, data-driven irrigation architecture leveraging LPWAN telemetry and time-series observability.

## About The Project
This repository hosts the hardware and software architecture of an autonomous LoRaWAN-based smart irrigation system. The edge infrastructure consists of an Arduino MKR WAN 1310 sensor node for environmental telemetry and an ESP32-controlled motorized ball valve. The system implements a complete data pipeline leveraging The Things Network (TTN) for LoRaWAN routing, MQTT for decoupled communication, a Node.js state machine to evaluate soil moisture deficits, InfluxDB for time-series persistence, and Grafana for real-time observability.

## System Architecture
* **Edge Devices:** Arduino MKR WAN 1310 (Sensors) & ESP32 (Actuator).
* **Network Server:** The Things Network (TTN) via OTAA provisioning.
* **Middleware:** Eclipse Mosquitto (MQTT Broker) & Node.js (State Machine & TSDB Bridge).
* **Persistence:** InfluxDB 3 (Time-Series Database).
* **Observability:** Grafana (Dashboard as Code).

## Repository Structure
* `/Firmware`: C++ source code for the Arduino sensor node and ESP32 actuator.
* `/Backend`: Node.js scripts for MQTT subscription, autonomous watering logic, and InfluxDB data ingestion.
* `/Hardware`: STL files for 3D printed weather-proof enclosures.
* `/Docs`: Grafana dashboard JSON exports and TTN JavaScript payload formatters.

## Getting Started
1. **Hardware Setup:** Flash the `.ino` files located in `/Firmware` to their respective microcontrollers.
2. **TTN Configuration:** Register the devices on The Things Network and apply the Uplink Decoder provided in `/Docs/formatter.js`.
3. **Backend Deployment:** Install dependencies (`npm install mqtt @influxdata/influxdb-client node-fetch`) and execute the Node.js services to bridge TTN and InfluxDB.
4. **Observability:** Import `Docs/grafana_dashboard.json` into your Grafana instance to instantly replicate the visual interface.

## License
Distributed under the MIT License. Open-source contribution for the IoT and Maker community.
