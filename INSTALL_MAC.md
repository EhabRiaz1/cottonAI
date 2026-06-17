# Installing Cotton AI on macOS

1. Double-click `Cotton AI_0.1.0_x64.dmg`.
2. Drag the **Cotton AI** icon onto the **Applications** folder shortcut.
3. Eject the DMG.

## First launch

Because Cotton AI is not yet signed with an Apple Developer certificate, macOS will block it the first time you open it from the Applications folder. This is a one-time step.

### Option A — easiest (Terminal, one command)

Open **Terminal** and run:

```bash
xattr -cr "/Applications/Cotton AI.app"
```

Then double-click Cotton AI in Applications. It will open normally and never be blocked again.

### Option B — without using Terminal

1. Double-click **Cotton AI** in Applications.
2. macOS shows *"Cotton AI cannot be opened because Apple cannot check it for malicious software."* — click **Cancel**.
3. Open **System Settings → Privacy & Security**.
4. Scroll down — you'll see *"Cotton AI was blocked from use because it is not from an identified developer."* Click **Open Anyway**.
5. Confirm with Touch ID or your Mac password.
6. Cotton AI launches and is whitelisted from then on.

## Why does this happen?

Cotton AI is an internal/early-access app. To distribute it without these warnings, the app needs to be signed and notarized by Apple, which requires a paid Apple Developer Program account ($99/year). Once that's set up, recipients can install Cotton AI like any App Store app — no warnings, no Terminal commands.
