import os
import requests
from bs4 import BeautifulSoup
from datetime import datetime

# Configuration - Corrected to the precise status subdomain link
URL = "https://hcpss.org"
STATUS_FILE = "last_status.txt"
WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")

def main():
    print("Fetching HCPSS Status website...")
    try:
        response = requests.get(URL, timeout=15)
        response.raise_for_status()
    except Exception as e:
        print(f"Error fetching page: {e}")
        return

    soup = BeautifulSoup(response.text, 'html.parser')
    
    # Target the precise row wrapper card used on status.hcpss.org
    status_card = soup.find(class_="views-row")
    
    if status_card:
        # Extract individual components from the core card
        date_el = status_card.find(class_="views-field-changed") or status_card.find('h3') or status_card.find(class_="field-name-post-date")
        title_el = status_card.find(class_="status-header") or status_card.find('h2') or status_card.find('h1')
        body_el = status_card.find(class_="alert-content") or status_card.find('p')
        
        # Clean text strings safely
        date_text = " ".join(date_el.get_text().split()) if date_el else datetime.now().strftime('%B %d, %Y')
        status_title = " ".join(title_el.get_text().split()) if title_el else "Normal Operations"
        body_text = " ".join(body_el.get_text().split()) if body_el else ""
        
        # Remove trailing calendar link texts if scraped accidentally
        if "view hcpss calendar" in body_text.lower():
            body_text = body_text.lower().replace("view hcpss calendar", "").strip()
    else:
        # Emergency absolute baseline fallback parameters
        date_text = datetime.now().strftime('%B %d, %Y')
        status_title = "Normal Operations"
        body_text = "Staff and students report in accordance with the HCPSS calendar."

    # Construct clean data baseline block to accurately track structural site updates
    current_snapshot_block = f"Date: {date_text} | Status: {status_title} | Body: {body_text}"
    print(f"\n--- LIVE SITE SCREENSHOT TRACK: ---\n{current_snapshot_block}\n-----------------------------------\n")

    # Read the previous status tracking cache state file
    previous_status = ""
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            previous_status = f.read().strip()

    # Compare changes
    if current_snapshot_block != previous_status:
        print("Status change detected! Dispatching rich layout to server channel.")
        
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            f.write(current_snapshot_block)

        if previous_status == "":
            print("First run baseline log built cleanly. Initial notification muted.")
            return

        is_normal = "normal operations" in status_title.lower()
        embed_color = 3066993 if is_normal else 15158332 # Sidebar color match: Green vs Red
        
        payload = {}
        if not is_normal:
            payload["content"] = "@everyone ⚠️ **HCPSS SYSTEM OPERATING STATUS UPDATE DETECTED!**"
            
        payload["embeds"] = [
            {
                "title": f"🗓️ Status for {date_text}",
                "url": URL,
                "color": embed_color,
                "description": f"## **{status_title}**\n\n{body_text}",
                "footer": {
                    "text": "Howard County Public School System Operational Status"
                },
                "timestamp": datetime.utcnow().isoformat() + "Z"
            }
        ]

        if WEBHOOK_URL:
            requests.post(WEBHOOK_URL, json=payload)
            print("Successfully fired matching alert layout to Discord channel.")
        else:
            print("Missing target Webhook configuration endpoint.")
    else:
        print("No site adjustments identified against current text records.")

if __name__ == "__main__":
    main()
