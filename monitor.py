import os
import json
import requests
from bs4 import BeautifulSoup
from datetime import datetime
import pytz

# Configuration
URL = "https://hcpss.org"
STATUS_FILE = "last_status.txt"
MSG_ID_FILE = "last_message_id.txt"
WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")
STUDENT_ROLE_PING = "<@&1521688178057154683>"

def clean_webhook_url():
    if not WEBHOOK_URL:
        return ""
    # FIXED: Added [0] index bracket to return a clean URL string block
    return WEBHOOK_URL.split('?')[0]

def delete_old_message(msg_id):
    """Deletes the old message from Discord using the webhook token."""
    base_url = clean_webhook_url()
    if not base_url or not msg_id:
        return
    try:
        delete_url = f"{base_url}/messages/{msg_id}"
        response = requests.delete(delete_url, timeout=10)
        
        if response.status_code == 204 or response.status_code == 404:
            print(f"Old status message handled successfully (ID: {msg_id}).")
        else:
            print(f"Could not delete message {msg_id}: Status Code {response.status_code}")
    except Exception as e:
        print(f"Error executing message deletion: {e}")

def main():
    eastern_tz = pytz.timezone('America/New_York')
    now_local = datetime.now(eastern_tz)
    
    print("Fetching HCPSS Status website...")
    try:
        response = requests.get(URL, timeout=15)
        response.raise_for_status()
    except Exception as e:
        print(f"Error fetching page: {e}")
        return

    soup = BeautifulSoup(response.text, 'html.parser')
    status_cards = soup.find_all(class_="views-row")
    
    extracted_blocks = []
    all_text_combined = ""
    is_normal = True
    has_multiple_statuses = len(status_cards) > 1

    if status_cards:
        for card in status_cards:
            date_el = card.find(class_="views-field-changed") or card.find('h3') or card.find(class_="field-name-post-date")
            title_el = card.find(class_="status-header") or card.find('h2') or card.find('h1')
            body_el = card.find(class_="alert-content") or card.find('p')
            
            date_text = " ".join(date_el.get_text().split()) if date_el else ""
            status_title = " ".join(title_el.get_text().split()) if title_el else ""
            body_text = " ".join(body_el.get_text().split()) if body_el else ""
            
            if "view hcpss calendar" in body_text.lower():
                body_text = body_text.lower().replace("view hcpss calendar", "").strip()

            if status_title and "normal operations" not in status_title.lower():
                is_normal = False

            card_markdown = ""
            if status_title:
                card_markdown += f"## **{status_title}**\n\n"
            if body_text:
                card_markdown += f"{body_text}\n"
                
            if card_markdown:
                extracted_blocks.append((date_text, card_markdown))
                all_text_combined += f"{date_text} {status_title} {body_text} "
    
    if not extracted_blocks:
        extracted_blocks.append((now_local.strftime('%B %d, %Y'), "## **Normal Operations**\n\nStaff and students report in accordance with the HCPSS calendar."))
        all_text_combined = "Normal Operations"

    primary_date = extracted_blocks[0][0] if extracted_blocks else now_local.strftime('%B %d, %Y')
    final_description = "\n___\n\n".join([block[1] for block in extracted_blocks])
    current_snapshot_block = " ".join(all_text_combined.split())

    is_daily_broadcast_time = (now_local.hour == 0 and 0 <= now_local.minute <= 45)

    previous_status = ""
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            previous_status = f.read().strip()

    has_text_changed = (current_snapshot_block != previous_status)

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

        if os.path.exists(MSG_ID_FILE):
            with open(MSG_ID_FILE, "r", encoding="utf-8") as f:
                old_raw = f.read().strip()
                if "," in old_raw:
                    old_data = old_raw.split(",")
                    old_msg_id = old_data[0]
                    old_was_multi = old_data[1] == "True"
                    
                    if not old_was_multi:
                        delete_old_message(old_msg_id)

        embed_color = 3066993 if is_normal else 15158332
        payload["embeds"] = [
            {
                "title": f"🗓️ Status for {primary_date}",
                "url": URL,
                "color": embed_color,
                "description": final_description,
                "footer": {
                    "text": "Howard County Public School System Daily Monitor"
                },
                "timestamp": datetime.utcnow().isoformat() + "Z"
            }
        ]

        base_url = clean_webhook_url()
        if base_url:
            url_with_wait = f"{base_url}?wait=true"
            response = requests.post(url_with_wait, json=payload)
            
            if response.status_code == 200 or response.status_code == 201:
                try:
                    new_msg_id = response.json().get("id")
                    with open(MSG_ID_FILE, "w", encoding="utf-8") as f:
                        f.write(f"{new_msg_id},{has_multiple_statuses}")
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
