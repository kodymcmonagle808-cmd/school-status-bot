import os
import json
import requests
from bs4 import BeautifulSoup
from datetime import datetime
import pytz

# Configuration
URL = "https://hcpss.org"
STATUS_FILE = "last_status.txt"
MSG_ID_FILE = "last_message_id.txt"  # Tracks old Discord message IDs to delete them
WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")
STUDENT_ROLE_PING = "<@&1521688178057154683>"

def delete_old_message(msg_id):
    """Deletes the old message from Discord using the webhook token."""
    if not WEBHOOK_URL or not msg_id:
        return
    try:
        # Construct the specialized deletion endpoint URL using the saved message ID
        # Requires appending ?wait=true to the baseline webhook address
        base_url = WEBHOOK_URL.split('?')[0]
        delete_url = f"{base_url}/messages/{msg_id}"
        response = requests.delete(delete_url, timeout=10)
        if response.status_code in:
            print(f"Successfully deleted old status message (ID: {msg_id}) from channel.")
        else:
            print(f"Could not delete message {msg_id}: {response.status_code}")
    except Exception as e:
        print(f"Error executing message deletion: {e}")

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
    
    # Check for Maryland local time
    eastern_tz = pytz.timezone('America/New_York')
    now_local = datetime.now(eastern_tz)
    is_daily_broadcast_time = (now_local.hour == 0 and 0 <= now_local.minute <= 45)

    previous_status = ""
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            previous_status = f.read().strip()

    has_text_changed = (current_snapshot_block != previous_status)
    is_normal = "normal operations" in status_title.lower()

    # Smart scanning rules to catch stacked multi-day text listings
    # If the text body contains dates or multiple lines of text, it counts as a multi-status layout
    has_multiple_days = any(k in body_text.lower() for k in ["june", "july", "january", "february", "march", "delayed", "closed"]) or "\n" in body_text

    should_send_discord = False
    payload = {}

    if is_daily_broadcast_time:
        should_send_discord = True
        if not is_normal:
            payload["content"] = f"{STUDENT_ROLE_PING} ⚠️ **HCPSS EMERGENCY STATUS ACTIVE AT MIDNIGHT!**"
        else:
            payload["content"] = "☀️ **Good Morning! Here is your Daily HCPSS Status Report:**"
            
    elif has_text_changed and not is_normal:
        should_send_discord = True
        payload["content"] = f"{STUDENT_ROLE_PING} ⚠️ **HCPSS SYSTEM OPERATING STATUS UPDATE DETECTED!**"
        
    elif has_text_changed and is_normal and previous_status != "":
        should_send_discord = True
        payload["content"] = "✅ **HCPSS Status Restored to Normal Parameters:**"

    if has_text_changed:
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            f.write(current_snapshot_block)

    if should_send_discord:
        if previous_status == "" and not is_daily_broadcast_time:
            print("First run repository setup initialization. Notification bypassed.")
            return

        # ----------------------------------------------------
        # HOOK DELETION LOGIC BLOCK
        # Only triggers deletion if the old status is NOT a multi-day announcement card
        # ----------------------------------------------------
        if os.path.exists(MSG_ID_FILE):
            with open(MSG_ID_FILE, "r", encoding="utf-8") as f:
                old_data = f.read().strip().split(",")
                if len(old_data) == 2:
                    old_msg_id, old_was_multi = old_data[0], old_data[1] == "True"
                    
                    # If the previous message was NOT a stacked complex message, delete it now
                    if not old_was_multi:
                        delete_old_message(old_msg_id)
                    else:
                        print("Preserving previous post because it contained a complex multi-day status stack.")

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
            # Appending ?wait=true forces Discord to reply with the sent message ID JSON metadata
            url_with_wait = WEBHOOK_URL.split('?')[0] + "?wait=true"
            response = requests.post(url_with_wait, json=payload)
            
            if response.status_code in:
                try:
                    new_msg_id = response.json().get("id")
                    # Save the new message ID along with whether this current alert is multi-day
                    with open(MSG_ID_FILE, "w", encoding="utf-8") as f:
                        f.write(f"{new_msg_id},{has_multiple_days}")
                    print(f"Successfully tracked new message ID: {new_msg_id}")
                except Exception as ex:
                    print(f"Failed to isolate message response JSON tokens: {ex}")
            else:
                print(f"Webhook connection anomaly: {response.status_code}")
        else:
            print("Missing webhook secret string identifier.")
    else:
        print("Site update did not meet emergency alert criteria. Status remains normal.")

if __name__ == "__main__":
    main()
