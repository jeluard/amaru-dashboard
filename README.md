# Amaru Dashboard

A web dashboard for monitoring an [Amaru](https://github.com/pragma-org/amaru) Cardano node. It connects via WebSocket to a running node and displays real-time metrics on an interactive globe.

## Prerequisites

- A running Amaru node
- A locally running [OTEL websocket bridge](https://github.com/jeluard/otel-ui?tab=readme-ov-file#running-the-backend-via-docker)
- Then browse https://jeluard.github.io/amaru-dashboard

## Getting Started

```sh
make bootstrap   # install dependencies
make dev         # start the dev server (default port: 8082)
```

Open `http://localhost:8082` in your browser.

## Configuration

The dashboard is configured via URL hash parameters:

| Parameter     | Default                  | Description                                      |
|---------------|--------------------------|--------------------------------------------------|
| `network`     | `preprod`                | Cardano network name                             |
| `ws`          | auto-detected            | WebSocket URL, e.g. `ws://localhost:8080/ws`     |
| `geo`         | `built-in`               | Geo endpoint for peer location lookup            |
| `origin`      | `51.5074,-0.1278`        | Lat/lon of your local node (comma-separated)     |
| `originLabel` | `local-node`             | Label shown on the globe for your local node     |

**Example:**
```
http://localhost:8082/#network=mainnet&ws=ws://mynode:8080/ws&origin=48.8566,2.3522&originLabel=paris-node
```
