# Mobile privacy inventory (pre-release)

Flippars does not require a user account in the guest release. The client creates a random installation UUID, stores it with iOS Keychain protection, and sends it to the Flippars API to associate notification preferences and a push token. The app stores onboarding state, preferences, recent public signal history, and the latest public market snapshot locally.

The mobile client does not collect contacts, location, advertising identifiers, exchange credentials, financial account details, or trading activity. It does not enable cross-app tracking. “Delete/reset anonymous data” attempts to remove the device record from the API, clears all Flippars AsyncStorage keys, deletes the Keychain installation identifier, and creates a fresh guest session.

Operational server logs, retention periods, market-data licensing, the production privacy-policy URL, and App Store privacy labels must be reviewed with backend operations and counsel before public release.
