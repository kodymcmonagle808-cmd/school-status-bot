import os
import requests
from bs4 import BeautifulSoup
from datetime import datetime
import pytz # Handles Eastern Standard/Daylight Time adjustments automatically

# Configuration
URL = "https://status.hcpss.org/"
STATUS_FILE = "last_status.txt"
WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")
STUDENT_ROLE_PING = "<@&1521688178057154683>"

def main():
    print("Fetching HCPSS Status website...")
    try:
        response = requests.get(URL, timeout=15)
        response.raise_for_status()
    except Exception as e:
        print(f"Error fetching page: {e}")
        return

    soup = BeautifulSoup(response.text, 'html.parser')
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
    
    # Force evaluation into Maryland/Eastern local timezone values
    eastern_tz = pytz.timezone('America/New_York')
    now_local = datetime.now(eastern_tz)
    
    # True if the execution window lands inside the 12:00 AM to 12:45 AM local bracket
    is_daily_broadcast_time = (now_local.hour == 0 and 0 <= now_local.minute <= 45)

    previous_status = ""
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            previous_status = f.read().strip()

    # Base state tracks
    has_text_changed = (current_snapshot_block != previous_status)
    is_normal = "normal operations" in status_title.lower()

    # CRITICAL EVALUATION RULES:
    # 1. Trigger if it is the local midnight window.
    # 2. Trigger if the status changed AND it is an actual emergency alert.
    # 3. If the website just changes internal timestamps but stays "Normal Operations", stay silent.
    should_send_discord = False
    payload = {}

    if is_daily_broadcast_time:
        should_send_discord = True
        # If it happens to find an active closure right at midnight, attach the student role ping
        if not is_normal:
            payload["content"] = f"{STUDENT_ROLE_PING} ⚠️ **HCPSS EMERGENCY STATUS ACTIVE AT MIDNIGHT!**"
        else:
            payload["content"] = "☀️ **Good Morning! Here is your Daily HCPSS Status Report:**"
            
    elif has_text_changed and not is_normal:
        # Instant emergency break alert trigger outside midnight hours
        should_send_discord = True
        payload["content"] = f"{STUDENT_ROLE_PING} ⚠️ **HCPSS SYSTEM OPERATING STATUS UPDATE DETECTED!**"
        
    elif has_text_changed and is_normal and previous_status != "":
        # Schools were closed/delayed, but now they just changed BACK to normal operations
        should_send_discord = True
        payload["content"] = "✅ **HCPSS Status Restored to Normal Parameters:**"

    # Always save the newest track data locally so the file matches the site layout state
    if has_text_changed:
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            f.write(current_snapshot_block)

    # Dispatch to Discord if conditions pass validation checks
    if should_send_discord:
        if previous_status == "" and not is_daily_broadcast_time:
            print("First run repository setup initialization. Notification bypassed.")
            return

        embed_color = 3066993 if is_normal else 15158332
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
            print("Successfully sent verified alert to Discord.")
        else:
            print("Missing webhook secret string identifier.")
    else:
        print("Site update did not meet emergency alert criteria. Status remains normal.")

if __name__ == "__main__":
    main()
