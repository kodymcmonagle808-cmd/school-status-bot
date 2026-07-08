import os
import requests
from bs4 import BeautifulSoup

# Configuration
URL = "https://hcpss.org"
STATUS_FILE = "last_status.txt"
WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")

def main():
    # 1. Fetch the HCPSS status page
    try:
        response = requests.get(URL, timeout=15)
        response.raise_for_status()
    except Exception as e:
        print(f"Error fetching page: {e}")
        return

    # 2. Parse the HTML text
    soup = BeautifulSoup(response.text, 'html.parser')
    
    # Cleans and extracts text content safely
    current_status = soup.get_text().strip()
    
    # Fallback to broad text chunking if page structure is minimal
    if not current_status:
        print("Could not parse text from page.")
        return

    # Shorten text to avoid capturing variable system timestamps if necessary
    # Usually the main operational status is at the very top
    current_status_snapshot = " ".join(current_status.split()[:50])

    # 3. Read the previous saved status
    previous_status = ""
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            previous_status = f.read().strip()

    # 4. Compare status states
    if current_status_snapshot != previous_status:
        print("Status change detected!")
        
        # Save the new status locally
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            f.write(current_status_snapshot)

        # Skip sending a Discord alert on the very first script run
        if previous_status == "":
            print("Initial baseline established. No alert sent.")
            return

        # 5. Send alert to Discord
        payload = {
            "content": f"🚨 **HCPSS Operating Status Change Detected!**\nCheck details here: {URL}"
        }
        if WEBHOOK_URL:
            requests.post(WEBHOOK_URL, json=payload)
        else:
            print("Discord Webhook URL secret is missing.")
    else:
        print("No changes detected. Status matches previous check.")

if __name__ == "__main__":
    main()
