import os
import requests
from bs4 import BeautifulSoup
from datetime import datetime

# Configuration
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
    
    # Target the exact row wrapper card used on status.hcpss.org
    status_card = soup.find(class_="views-row")
    
    if status_card:
        date_el = status_card.find(class_="views-field-changed") or status_card.find('h3') or status_card.find(class_="field-name-post-date")
        title_el = status_card.find(class_="status-header") or status_card.find('h2') or status_card.find('h1')
        body_el = status_card.find(class_="alert-content") or status_card.find('p')
        
        date_text = " ".join(date_el.get_text().split()) if date_el else datetime.now().strftime('%B %d, %Y')
        status_title = " ".join(title_el.get_text().split()) if title_el else "Normal Operations"
        body_text = " ".join(body_el.get_text().split()) if body_el else ""
        
        if "view hcpss calendar" in body_text.lower():
            body_text = body_text.lower().replace("view hcpss calendar", "").strip()
    else:
        date_text = datetime.now().strftime('%B %d, %Y')
        status_title = "Normal Operations"
        body_text = "Staff and students report in accordance with the HCPSS calendar."

    current_snapshot_block = f"Date: {date_text} | Status: {status_title} | Body: {body_text}"
    
    # Check if this exact 15-minute run happens to be the daily 12:01 AM window
    now = datetime.now()
    is_daily_broadcast_time = (now.hour == 0 and 0 <= now.minute <= 15)

    # Read the previous status tracking cache file
    previous_status = ""
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            previous_status = f.read().strip()

    # Determine if we should post (due to a change OR because it's midnight)
    should_post_update = (current_snapshot_block != previous_status)
    
    if should_post_update or is_daily_broadcast_time:
        # Save state right away to track future structural changes
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            f.write(current_snapshot_block)

        # Baseline check to ensure it doesn't alert on the very first script deployment initialization
        if previous_status == "" and not is_daily_broadcast_time:
            print("First run baseline log built cleanly. Initial notification muted.")
            return

        is_normal = "normal operations" in status_title.lower()
        embed_color = 3066993 if is_normal else 15158332
        
        payload = {}
        
        # Heading layout tags: Emergency ping to @Student vs Normal Daily layout header
        if not is_normal:
            payload["content"] = "@Student ⚠️ **HCPSS SYSTEM OPERATING STATUS UPDATE DETECTED!**"
        elif is_daily_broadcast_time and not should_post_update:
            payload["content"] = "☀️ **Good Morning! Here is your Daily HCPSS Status Report:**"

        payload["embeds"] = [
            {
                "title": f"🗓️ Status for {date_text}",
                "url": URL,
                "color": embed_color,
                "description": f"## **{status_title}**\n\n{body_text}",
                "footer": {
                    "text": "Howard County Public School System Daily Monitor"
                },
                "timestamp": datetime.utcnow().isoformat() + "Z"
            }
        ]

        if WEBHOOK_URL:
            requests.post(WEBHOOK_URL, json=payload)
            print("Successfully fired payload to Discord channel.")
        else:
            print("Missing Webhook Endpoint secret.")
    else:
        print("No changes found, and it is not midnight. Staying quiet.")

if __name__ == "__main__":
    main()
