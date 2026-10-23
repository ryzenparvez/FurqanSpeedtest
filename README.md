# FurqanCloud Speed Test

```
furqancloud-speedtest/
├── public/index.html                  Web UI (served by server.js)
├── server.js                          Test server – no dependencies, Node 18+
├── package.json
├── Dockerfile
└── deploy/
    ├── nginx.conf                     HTTPS reverse proxy (no buffering / no gzip for test paths)
    └── furqancloud-speedtest.service  systemd unit
```

## Endpoints
| Path | Purpose |
|---|---|
| `GET /__down?bytes=N` | Streams N random bytes (download + ping probe) |
| `POST /__up` | Receives and discards upload data |
| `GET /__ping` | Tiny reply |
| `GET /meta` | Client IP + server name |
| `GET /health` | Liveness check |

## Run
```bash
node server.js                # http://localhost:3000
# or
docker build -t fc-speedtest . && docker run -p 3000:3000 fc-speedtest
```

Environment variables: `PORT`, `HOST`, `SERVER_NAME`, `SERVER_LOCATION`, `ALLOWED_ORIGIN`,
`TRUST_PROXY` (1 behind nginx), `MAX_DOWN_BYTES`, `MAX_UP_BYTES`, `MAX_CONN_PER_IP`.

## Production (Ubuntu)
1. Copy this folder to `/opt/furqancloud-speedtest`, create user `speedtest`.
2. Install `deploy/furqancloud-speedtest.service`, then `systemctl enable --now furqancloud-speedtest`.
3. Install `deploy/nginx.conf` (edit domain), get a certificate with certbot, `nginx -s reload`.
4. Use a 1 Gbps+ port on the VPS; the test is only as accurate as the server's uplink.

## Multiple locations
Deploy the same folder on each node, then add them to `SERVERS` in `public/index.html`:
```js
{ id: 'fc-sg', name: 'FurqanCloud · Singapore', base: 'https://sg.speed.furqancloud.com' }
```
For remote nodes set `ALLOWED_ORIGIN` to the domain hosting the page. The UI pings every node and
"Auto" selects the lowest latency; offline nodes are disabled in the dropdown.
