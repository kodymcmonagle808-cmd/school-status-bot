# Privacy Policy for School Status

**Last Updated: July 29, 2026**

This Privacy Policy explains what information the "School Status" Discord bot ("the Bot," "we," "us," or "our") collects, how it is used, and your rights regarding that information.

## 1. Information We Collect

School Status is designed to collect the **minimum data necessary** to function. This typically includes:

**Server (Guild) Configuration Data:**
- Discord Server (Guild) ID and server name
- Designated status-announcement Channel ID
- Optional Role ID(s) configured to be pinged on alerts
- Server-specific settings (e.g., which alert types are enabled)

**Command Usage Data:**
- User ID and Channel ID at the time a command is run, used only to process and respond to that command.

**Opt-In Notification Data:**
- If a user runs `/myschool`, the school name they typed is stored with their User ID and used solely to match publicly posted school-specific notices for DM alerts. It is removed with `/myschool clear`, when the server's data is deleted, or when the bot leaves the server.

**We do NOT collect:**
- Message content outside of direct command interactions
- Private messages
- Personal information such as names, email addresses, or school enrollment data
- Voice channel data or audio

## 2. How We Use Information

Collected data is used solely to:
- Deliver automated HCPSS status updates to the configured channel(s).
- Ping configured roles when an alert is posted, if enabled.
- Respond to manual status-check commands.
- Maintain and troubleshoot the Bot's functionality.

We do not sell, rent, or share collected data with third parties for advertising or marketing purposes.

## 3. Data Storage and Security

- Configuration data (Guild ID, Channel ID, Role ID) is stored in a secure database associated with the Bot's hosting infrastructure.
- Reasonable technical measures are used to protect stored data from unauthorized access.
- The Bot also writes an operational log of its own actions — what it posted, to which channel, and which configuration settings were changed (including the Discord ID of the person who changed one). These lines are held by the hosting platform for a few days and then discarded automatically. Your server's staff can read them from the control panel's **System Logs** page, which is reachable only through a private link that expires 30 minutes after it is issued and shows no other server's activity.
- No system can be guaranteed 100% secure; data is stored and processed at your own risk.

## 4. Data Retention and Deletion

- Server configuration data is retained only as long as the Bot remains in your server.
- If the Bot is removed from a server, associated configuration data is deleted automatically or within a reasonable period afterward.
- Server admins may erase all of their server's data at any time with the `/mydata delete` command, or request manual deletion through the Bot's support channel.
- The operational log described in Section 3 is the one exception: those lines age out on the hosting platform's own schedule and cannot be deleted on request. They record the Bot's actions, not message content.

## 5. Third-Party Services

The Bot may retrieve publicly available information from HCPSS's public website or communications in order to generate status updates. This process does not involve sharing any of your Discord data with HCPSS or any third party — information flows one way, from public sources into the Bot.

The Bot operates on Discord's platform and is subject to Discord's own [Privacy Policy](https://discord.com/privacy) and [Terms of Service](https://discord.com/terms) for any data Discord itself collects.

## 6. Children's Privacy

The Bot does not knowingly collect personal information from anyone, and does not target or solicit information specifically from children. Discord itself requires users to meet its own minimum age requirements as outlined in Discord's Terms of Service.

## 7. Your Rights

Server administrators may:
- View a summary of what data is stored for their server with the `/mydata view` command.
- Delete their server's configuration data with `/mydata delete` (removing the Bot also accomplishes this).
- Reach out with questions or concerns about data handling.

## 8. Changes to This Policy

This Privacy Policy may be updated periodically to reflect changes in the Bot's functionality or data practices. Continued use of the Bot after updates constitutes acceptance of the revised policy. The "Last Updated" date above will reflect the most recent revision.

## 9. Contact

For questions, concerns, or data deletion requests, please reach out through the Bot's support server or the contact method listed on its official listing page.

---

*By using School Status, you acknowledge that you have read and understood this Privacy Policy.*
