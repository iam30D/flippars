# Guest Privacy Notice Template

> This is an implementation template and must receive jurisdiction-specific
> legal review before publication.

Flippars provides informational Bitcoin market observations and qualified model
signals. The guest version does not require a name, email address, exchange
account, wallet, portfolio, contacts, or precise location.

To deliver the service, Flippars may process:

- A random installation identifier
- A one-way hash of a separate guest mutation credential; the raw credential
  remains in the device Keychain
- The device notification token and notification preferences
- Security, reliability, and privacy-preserving diagnostic events

These records are used to deliver requested alerts, recover preferences, prevent
abuse, diagnose failures, and protect signal integrity. They are not used to
place trades or access financial accounts.

The application provides a control to delete/reset guest data and notification
registration. If the service is temporarily unreachable, the device keeps an
encrypted deletion request and retries it later. A granted iOS notification
permission does not by itself opt the guest into Flippars alerts; the app sends
the APNs token only after a separate in-app choice.

Required fraud, security, audit, or legal records may follow a separately
disclosed retention schedule. Production contact details, vendors,
international transfer information, legal bases, rights, retention periods,
and complaint routes must be inserted before release. This template must be
reconciled with the final App Store privacy answers and deployed vendors.
