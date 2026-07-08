import os
import requests
from bs4 import BeautifulSoup

# Configuration
URL = "https://status.hcpss.org/"
STATUS_FILE = "last_status.txt"
WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")

def main():
    print("Fetching HCPSS website...")
    try:
        # Request the precise status page URL directly
        response = requests.get(URL, timeout=15)
        response.raise_for_status()
    except Exception as e:
        print(f"Error fetching page: {e}")
        return

    soup = BeautifulSoup(response.text, 'html.parser')
    
    # 1. Target the exact text title block of the main operational widget banner
    status_header_el = soup.find(class_="status-header")
    
    if status_header_el:
        current_status = status_header_el.get_text().strip()
    else:
        # Fallback layout parsing option if structural tags adapt
        fallback_h1 = soup.find('h1')
        current_status = fallback_h1.get_text().strip() if fallback_h1 else "Unknown Status"

    # Clean up excess internal system whitespace or line breaks
    current_status = " ".join(current_status.split())
    print(f"\n--- LIVE OPERATION STATUS IS DETECTED AS: '{current_status}' ---\n")

    # 2. Read the previous status state
    previous_status = ""
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            previous_status = f.read().strip()

    # 3. Process status logic and ping conditions
    if current_status != previous_status:
        print(f"Status mismatch! Updating state track from '{previous_status}' to '{current_status}'")
        
        # Save state right away to prevent loop triggers
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            f.write(current_status)

        # Baseline skip check to ensure it doesn't alert on the first deployment initialization
        if previous_status == "":
            print("First run baseline setup complete. Quiet mode active.")
            return

        # Core alert logic block
        # If the status is NOT normal operations, it triggers a critical server broadcast notice
        if "normal operations" not in current_status.lower():
            content_message = f"🚨 **@everyone EMERGENCY OPERATING STATUS CHANGE DETECTED!**\n\nCurrent Status: **{current_status}**\n\n🔗 Verify online here: {URL}"
        else:
            content_message = f"✅ **HCPSS Status Restored**\n\nCurrent Status: **{current_status}**\n\n🔗 Link: {URL}"

        payload = {"content": content_message}
        
        if WEBHOOK_URL:
            requests.post(WEBHOOK_URL, json=payload)
        else:
            print("Discord URL target missing.")
    else:
        print("Status is identical to the last check. No notification required.")

if __name__ == "__main__":
    main()
