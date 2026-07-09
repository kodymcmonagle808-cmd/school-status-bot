import os
import json
import requests
from bs4 import BeautifulSoup
from datetime import datetime
import pytz
from urllib.parse import parse_qsl, urlencode, urlsplit

# Configuration
URL = "https://hcpss.org"
STATUS_FILE = "last_status.txt"
MSG_ID_FILE = "last_message_id.txt"
WEBHOOK_STATE_FILE = os.getenv("DISCORD_WEBHOOK_STATE_FILE", "last_message_state.json")
LEGACY_ONDEMAND_STATE_FILE = "last_ondemand_message_state.json"
LEGACY_ONDEMAND_MSG_FILE = "last_ondemand_message_id.txt"
WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")
STUDENT_ROLE_PING = "<@&1521688178057154683>"

def _webhook_base_and_query():
    if not WEBHOOK_URL:
        return "", ""

    parsed = urlsplit(WEBHOOK_URL)
    base_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"

    # Preserve webhook routing params (for example thread_id) but control wait separately.
    passthrough = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k.lower() != "wait"]
    query = urlencode(passthrough)
    return base_url, query

def build_webhook_post_url():
    base_url, query = _webhook_base_and_query()
    if not base_url:
        return ""

    params = parse_qsl(query, keep_blank_values=True) if query else []
    params = [(k, v) for k, v in params if k.lower() != "wait"]
    params.append(("wait", "true"))
    return f"{base_url}?{urlencode(params)}"

def build_webhook_delete_url(msg_id):
    base_url, query = _webhook_base_and_query()
    if not base_url or not msg_id:
        return ""

    delete_url = f"{base_url}/messages/{msg_id}"
    if query:
        return f"{delete_url}?{query}"
    return delete_url

def load_webhook_state():
    if os.path.exists(WEBHOOK_STATE_FILE):
        try:
            with open(WEBHOOK_STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception as e:
            print(f"Warning: Could not read webhook state file: {e}")

    if os.path.exists(MSG_ID_FILE):
        try:
            with open(MSG_ID_FILE, "r", encoding="utf-8") as f:
                old_raw = f.read().strip()
                if "," in old_raw:
                    old_msg_id = old_raw.split(",")[0]
                    if old_msg_id:
                        return {"last_message_id": old_msg_id}
        except Exception as e:
            print(f"Warning: Could not read legacy webhook message ID file: {e}")

    if os.path.exists(LEGACY_ONDEMAND_STATE_FILE):
        try:
            with open(LEGACY_ONDEMAND_STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    last_message_id = data.get("last_message_id")
                    if last_message_id:
                        return {"last_message_id": last_message_id}
        except Exception as e:
            print(f"Warning: Could not read legacy on-demand webhook state file: {e}")

    if os.path.exists(LEGACY_ONDEMAND_MSG_FILE):
        try:
            with open(LEGACY_ONDEMAND_MSG_FILE, "r", encoding="utf-8") as f:
                old_msg_id = f.read().strip()
                if old_msg_id:
                    return {"last_message_id": old_msg_id}
        except Exception as e:
            print(f"Warning: Could not read legacy on-demand webhook message ID file: {e}")

    return {}

def save_webhook_state(state):
    try:
        with open(WEBHOOK_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f)
    except Exception as e:
        print(f"Warning: Could not write webhook state file: {e}")

def delete_old_message(msg_id):
    delete_url = build_webhook_delete_url(msg_id)
    if not delete_url:
        return
    try:
        response = requests.delete(delete_url, timeout=10)
        
        if response.status_code == 204:
            print(f"Deleted previous status message (ID: {msg_id}).")
        elif response.status_code in (401, 403, 404):
            print(f"Warning: Could not delete previous message {msg_id} (status {response.status_code}). Continuing.")
        else:
            print(f"Warning: Unexpected delete response for message {msg_id}: Status Code {response.status_code}. Continuing.")
    except Exception as e:
        print(f"Warning: Error deleting previous message {msg_id}: {e}. Continuing.")

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
    stable_snapshot_parts = []
    is_normal = True

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
                stable_snapshot_parts.append(f"{status_title} {body_text}")
    
    if not extracted_blocks:
        extracted_blocks.append((now_local.strftime('%B %d, %Y'), "## **Normal Operations**\n\nStaff and students report in accordance with the HCPSS calendar."))
        stable_snapshot_parts = ["Normal Operations"]

    primary_date = extracted_blocks[0][0] if extracted_blocks else now_local.strftime('%B %d, %Y')
    final_description = "\n___\n\n".join([block[1] for block in extracted_blocks])
    current_snapshot_block = " ".join(" ".join(stable_snapshot_parts).split())

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

        webhook_state = load_webhook_state()
        old_msg_id = webhook_state.get("last_message_id")
        if old_msg_id:
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

        post_url = build_webhook_post_url()
        if post_url:
            response = requests.post(post_url, json=payload, timeout=10)
            
            if response.status_code == 200 or response.status_code == 201:
                try:
                    new_msg_id = response.json().get("id")
                    if new_msg_id:
                        save_webhook_state({"last_message_id": new_msg_id})
                        print(f"Successfully tracked new message ID: {new_msg_id}")
                    else:
                        print("Warning: Webhook post succeeded but no message ID was returned. Previous state unchanged.")
                except Exception as ex:
                    print(f"Warning: Failed to parse webhook response JSON: {ex}. Previous state unchanged.")
            else:
                print(f"Webhook connection anomaly: {response.status_code}")
        else:
            print("Missing webhook secret string identifier.")
    else:
        print("Site update did not meet emergency alert criteria. Status remains normal.")

if __name__ == "__main__":
    main()
