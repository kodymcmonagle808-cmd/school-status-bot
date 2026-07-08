import os
import requests
from bs4 import BeautifulSoup
from datetime import datetime

# Configuration
URL = "https://hcpss.org"
STATUS_FILE = "last_status.txt"
WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")

def main():
    print("Fetching HCPSS website...")
    try:
        response = requests.get(URL, timeout=15)
        response.raise_for_status()
    except Exception as e:
        print(f"Error fetching page: {e}")
        return

    soup = BeautifulSoup(response.text, 'html.parser')
    
    # 1. Isolate main message block text 
    status_el = soup.find(class_=["status-header", "field-name-field-status-text"])
    if status_el:
        status_text = " ".join(status_el.get_text().split())
    else:
        status_text = "Normal Operations"

    # 2. Capture any active custom alert date strings if present
    date_text = "None posted (System is normal)"
    main_block = soup.find(id="block-system-main") or soup.find(class_="region-content")
    if main_block:
        for el in main_block.find_all(['p', 'div', 'span']):
            txt = el.get_text().strip()
            if any(k in txt.lower() for k in ["affected date", "status as of", "2026", "2027"]):
                date_text = " ".join(txt.split())
                break

    # Construct complete baseline tracker payload to trace variations over time
    current_snapshot_block = f"Status: {status_text} | Date: {date_text}"
    print(f"\n--- LIVE TRACKER STATE: {current_snapshot_block} ---\n")

    # Read the previous status state file
    previous_status = ""
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            previous_status = f.read().strip()

    # Compare running states
    if current_snapshot_block != previous_status:
        print("State tracking mismatch registered. Updating tracker files...")
        
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            f.write(current_snapshot_block)

        if previous_status == "":
            print("First run system baseline established. Quiet initialization active.")
            return

        is_normal = "normal operations" in status_text.lower()
        embed_color = 3066993 if is_normal else 15158332
        status_icon = "✅" if is_normal else "🚨"
        
        # Base broadcast structure setup
        payload = {}
        if not is_normal:
            payload["content"] = "@everyone ⚠️ **HCPSS SCHOOL STATUS MODIFICATION DETECTED!**"
            
        payload["embeds"] = [
            {
                "title": f"{status_icon} Automated Status Update Notice",
                "url": URL,
                "color": embed_color,
                "fields": [
                    {
                        "name": "🏫 Operating Status Description",
                        "value": f"**{status_text}**",
                        "inline": False
                    },
                    {
                        "name": "📅 Targeted Alert Dates",
                        "value": date_text,
                        "inline": False
                    }
                ],
                "footer": {
                    "text": "Automated Background Status Monitor"
                }
            }
        ]

        if WEBHOOK_URL:
            requests.post(WEBHOOK_URL, json=payload)
            print("Successfully fired matching alert payload to Discord channel.")
        else:
            print("Missing target Webhook configuration endpoint.")
    else:
        print("No adjustments found. Current site maps past logs perfectly.")

if __name__ == "__main__":
    main()
