# Mini Pickleball

## Docker deployment

Build and run the production container:

```bash
docker build -t mini-pickleball .
docker run --name mini-pickleball -p 3000:3000 --restart unless-stopped mini-pickleball
```

For Dokploy, deploy this repository as a Docker app. Dokploy will use the
`Dockerfile`, expose container port `3000`, and route your domain to that port.
The server reads `PORT` from the environment and binds to all interfaces.

### Live edits during development

The production image intentionally contains a fixed snapshot of the source.
For instant local edits without rebuilding, use:

```bash
docker compose -f docker-compose.dev.yml up
```

The source directory is mounted into the container and Node's watch mode
restarts the server when backend files change. Frontend HTML/CSS/JS changes
are immediately available after refreshing the browser. Production changes
should still be committed and redeployed in Dokploy so releases are stable and
recoverable.

A browser pickleball game with solo, shared-device, online, and tournament play.

## Run

Requires Node.js 18 or newer.

```sh
npm install
npm start
```

Open http://localhost:3000. Online opponents must connect to the same running server. Set `PORT` to choose a different port. Run the simulation checks with `npm test`.

## Controls

- Player 1: WASD to move (or arrow keys in solo and online play), Space or E to swing, Shift to slow walk/dink.
- Player 2: arrow keys to move, Enter or Slash to swing, Right Shift to slow walk/dink.
- Hold forward while swinging for a drive, or back for a lob. Swing at a high ball outside the kitchen for a smash. On touch devices, drag on the court to move, tap to swing, or swipe quickly for a directional shot. On-screen movement, hit, and slow buttons are also available. In local two-player games, use the bottom and top halves of the court for players 1 and 2.
- Online players use the Player 1 controls; the second player's input is reversed to face the court.

Choose a mode and match settings before starting. Private online rooms use a four-character code. Both players can toggle ready in the lobby; once both are ready, the host starts the match. Quick Match pairs the first two waiting players. After an online match, both players can accept a rematch, or either can return both to the lobby. Tournament matches can include up to four local humans, with remaining places filled by bots. Locker room choices are saved in the browser.
