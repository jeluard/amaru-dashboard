import countriesTopology from "world-atlas/countries-50m.json";
import { mesh } from "topojson-client";

const Cesium = window.Cesium;

const countryBorders = countriesTopology?.objects?.countries
  ? mesh(countriesTopology, countriesTopology.objects.countries)
  : null;

function toCartesian(latitude, longitude, height = 0) {
  return Cesium.Cartesian3.fromDegrees(longitude, latitude, height);
}

function buildArcPositions(origin, destination) {
  const midLat = (origin.latitude + destination.latitude) / 2;
  const midLon = (origin.longitude + destination.longitude) / 2;
  return [
    toCartesian(origin.latitude, origin.longitude, 0),
    toCartesian(midLat, midLon, 800000),
    toCartesian(destination.latitude, destination.longitude, 0)
  ];
}

async function addCountryBorders(viewer) {
  if (!countryBorders) {
    return null;
  }

  const dataSource = await Cesium.GeoJsonDataSource.load({
    type: "Feature",
    properties: {},
    geometry: countryBorders
  }, {
    stroke: Cesium.Color.fromCssColorString("#c7d5ff").withAlpha(0.72),
    strokeWidth: 1.35
  });

  for (const entity of dataSource.entities.values) {
    if (entity.polyline) {
      entity.polyline.clampToGround = true;
      entity.polyline.material = Cesium.Color.fromCssColorString("#c7d5ff").withAlpha(0.72);
      entity.polyline.width = 1.35;
    }
  }

  viewer.dataSources.add(dataSource);
  return dataSource;
}

export function createGlobe(container, config) {
  if (!Cesium) {
    return {
      render() {}
    };
  }

  const viewer = new Cesium.Viewer(container, {
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    shouldAnimate: true,
    skyBox: false,
    skyAtmosphere: false,
    scene3DOnly: true,
    imageryProvider: new Cesium.UrlTemplateImageryProvider({
      url: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
      subdomains: ["a", "b", "c", "d"]
    })
  });

  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#f1efe7");
  viewer.scene.globe.enableLighting = false;
  viewer.scene.globe.showGroundAtmosphere = false;
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#62d700");
  if (viewer.scene.moon) {
    viewer.scene.moon.show = false;
  }
  if (viewer.scene.sun) {
    viewer.scene.sun.show = false;
  }
  if (viewer.cesiumWidget.creditContainer) {
    viewer.cesiumWidget.creditContainer.style.display = "none";
  }
  viewer.scene.screenSpaceCameraController.enableZoom = true;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(config.originLon, config.originLat, 18000000)
  });
  addCountryBorders(viewer).catch(console.warn);

  let lastPeerFocus = 0;
  let focusedPeerIndex = 0;

  // Incremental entity tracking — avoids removeAll() flicker
  const peerEntities = new Map(); // peer key → { entity, status, cityName }
  const arcEntities = new Map();  // arc key → entity
  let originEntity = null;

  const origin = {
    latitude: config.originLat,
    longitude: config.originLon
  };

  return {
    render(snapshot) {
      // ── Origin marker (add once) ────────────────────────────────────────────
      if (!originEntity) {
        originEntity = viewer.entities.add({
          position: toCartesian(origin.latitude, origin.longitude, 0),
          point: {
            color: Cesium.Color.fromCssColorString("#05205f"),
            pixelSize: 10,
            outlineColor: Cesium.Color.fromCssColorString("#f1efe7"),
            outlineWidth: 2
          },
          label: {
            text: config.originLabel,
            font: "600 14px Inter, sans-serif",
            fillColor: Cesium.Color.WHITE,
            style: Cesium.LabelStyle.FILL,
            pixelOffset: new Cesium.Cartesian2(0, 18),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 10000000)
          }
        });
      }

      // ── Peer markers ────────────────────────────────────────────────────────
      const livePeerKeys = new Set();
      for (const peer of snapshot.peers) {
        if (!Number.isFinite(peer.latitude) || !Number.isFinite(peer.longitude)) continue;
        livePeerKeys.add(peer.peer);

        const color = peer.status === "active"
          ? "#66ff00"
          : peer.status === "disconnected"
            ? "#ff6b6b"
            : "#4a84ff";
        const labelText = peer.cityName && peer.cityName !== "derived"
          ? `${peer.peer}\n${peer.cityName}`
          : peer.peer;

        const cached = peerEntities.get(peer.peer);
        if (!cached) {
          // New peer — add entity
          const entity = viewer.entities.add({
            position: toCartesian(peer.latitude, peer.longitude, 0),
            point: {
              color: Cesium.Color.fromCssColorString(color),
              pixelSize: peer.status === "active" ? 8 : 6,
              outlineColor: Cesium.Color.fromCssColorString("#f1efe7"),
              outlineWidth: 1
            },
            label: {
              text: labelText,
              font: "500 12px Inter, sans-serif",
              fillColor: Cesium.Color.fromCssColorString("#f1efe7"),
              pixelOffset: new Cesium.Cartesian2(0, 14),
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 10000000)
            }
          });
          peerEntities.set(peer.peer, { entity, status: peer.status, cityName: peer.cityName });
        } else if (cached.status !== peer.status || cached.cityName !== peer.cityName) {
          // Status or geo changed — update in place
          cached.entity.point.color = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString(color));
          cached.entity.point.pixelSize = new Cesium.ConstantProperty(peer.status === "active" ? 8 : 6);
          cached.entity.label.text = new Cesium.ConstantProperty(labelText);
          cached.status = peer.status;
          cached.cityName = peer.cityName;
        }
      }

      // Remove stale peer entities
      for (const [key, { entity }] of peerEntities) {
        if (!livePeerKeys.has(key)) {
          viewer.entities.remove(entity);
          peerEntities.delete(key);
        }
      }

      // ── Live arcs ───────────────────────────────────────────────────────────
      const liveArcKeys = new Set();
      for (const arc of snapshot.liveArcs) {
        const arcKey = `${arc.peer}:${arc.connId}:${arc.status}`;
        liveArcKeys.add(arcKey);

        if (arcEntities.has(arcKey)) continue;

        const peer = snapshot.peers.find((entry) => entry.peer === arc.peer);
        if (!peer || !Number.isFinite(peer.latitude) || !Number.isFinite(peer.longitude)) continue;

        const isError = arc.status === "error";
        const arcColor = Cesium.Color.fromCssColorString(isError ? "#ff3333" : "#ffcc33").withAlpha(isError ? 0.75 : 0.85);

        const entity = viewer.entities.add({
          polyline: {
            positions: buildArcPositions(origin, peer),
            width: isError ? 2.5 : 3,
            material: new Cesium.ColorMaterialProperty(arcColor),
            arcType: Cesium.ArcType.NONE
          }
        });
        arcEntities.set(arcKey, entity);
      }

      // Remove expired arc entities
      for (const [key, entity] of arcEntities) {
        if (!liveArcKeys.has(key)) {
          viewer.entities.remove(entity);
          arcEntities.delete(key);
        }
      }

      // ── Camera auto-focus ───────────────────────────────────────────────────
      if (snapshot.peers.length && Date.now() - lastPeerFocus > 7000) {
        const peer = snapshot.peers[focusedPeerIndex % snapshot.peers.length];

        if (Number.isFinite(peer.latitude) && Number.isFinite(peer.longitude)) {
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(peer.longitude, peer.latitude, 8500000),
            duration: 2.8
          });
          focusedPeerIndex += 1;
          lastPeerFocus = Date.now();
        }
      }
    }
  };
}