# BFL player site (real Roblox login)

Search for players, open their profile card, and sign in with your Roblox account.
Avatars come straight from Roblox and update on their own.

## 1. Install
Install Node.js 18 or newer, then in this folder run:

    npm install

## 2. Register a Roblox OAuth app
1. Go to https://create.roblox.com/dashboard/credentials?activeTab=OAuthTab
2. Click **Create App**, enter a unique name, agree to the terms, click **Create**.
3. Copy the **Client ID** (the secret is not needed: this site uses PKCE).
4. Click **Continue to Edit**. Choose the category **Account Linking Tools**, then tick the scopes **openid** and **profile**.
5. Under redirect URLs add `http://localhost:3000/auth/callback`
   (when you put the site online, add `https://YOUR-SITE/auth/callback` too).

Until Roblox approves the app in a review, it stays in private mode and only 10 different people can sign in.
Roblox's guide: https://create.roblox.com/docs/cloud/auth/oauth2-registration

## 3. Run it
Mac / Linux:

    CLIENT_ID=your_id SESSION_SECRET=any_long_random_text BASE_URL=http://localhost:3000 npm start

Windows (PowerShell):

    $env:CLIENT_ID="your_id"; $env:SESSION_SECRET="any_long_random_text"; $env:BASE_URL="http://localhost:3000"; npm start

Open http://localhost:3000.

## 4. Put it online
Use any Node host (Render, Railway, Fly.io, a VPS). Set the same three values as
environment variables, with `BASE_URL` set to your real https address, and add
`BASE_URL/auth/callback` as a redirect URL in your Roblox app.
Sessions are kept in memory, so everyone is signed out when the server restarts.
That is fine for a small site; use a session store such as Redis for more.

## Adding or editing players
Edit `players.json`. Changes show up straight away, no restart needed.
A player's `name` must be their exact Roblox username: it is used to find their
avatar and to match them when they sign in. `rxphina10` has placeholder stats.
If the avatar can't be found, the card shows the blocky face instead.
