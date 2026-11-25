// ============================================================
// In-app guides — plain-language help for every module, opened from the
// "Guide" button in the top bar (src/components/guide/page-guide.tsx).
// Keyed by the first part of the page URL (/callbacks → 'callbacks').
// Written for non-technical team members: what the page is for, how to
// use it, and what every tab, label, tag and button means.
// ============================================================

export type Tone = 'amber' | 'sky' | 'rose' | 'emerald' | 'violet' | 'primary' | 'muted';

export interface GuideItem {
  label: string;
  text: string;
  /** Shown as a coloured chip, like on the page. */
  tone?: Tone;
}

export interface GuideSection {
  title: string;
  items: GuideItem[];
}

export interface Guide {
  title: string;
  tagline: string;
  steps: string[];
  sections: GuideSection[];
  tips: string[];
  /** Show the shared "Lead tags" glossary at the end. */
  tags?: boolean;
}

/** Tags the system adds to leads automatically. */
export const LEAD_TAGS: GuideItem[] = [
  { label: 'webinar_registered', tone: 'violet', text: 'The person registered for the webinar on the website. Their WhatsApp journey (confirmation, reminders, follow-ups) starts.' },
  { label: 'callback_requested', tone: 'amber', text: 'The person asked for a phone call. A card appears on the Callbacks page. Removed when the callback is marked Done.' },
  { label: 'payment_link_sent', tone: 'primary', text: 'The payment link was sent — by the journey or by a team member. The journey will not send its automatic payment link again.' },
  { label: 'paid', tone: 'emerald', text: 'The person paid. All sales follow-ups stop for them.' },
  { label: 'manually_closed', tone: 'muted', text: 'A team member closed this lead by hand. Automatic messages stop.' },
  { label: 'closed_lost', tone: 'rose', text: 'The person said they are not interested, or stopped responding at the end of follow-ups. If they message again, the team is notified.' },
];

const WINDOW_TIP =
  'WhatsApp rule: you can send normal messages only within 24 hours of the person’s last message. After that, only approved templates can be sent.';

export const GUIDES: Record<string, Guide> = {
  dashboard: {
    title: 'Dashboard',
    tagline: 'Your business at a glance — messages, replies, deals and campaigns in one place.',
    steps: [
      'Pick a time period at the top to change every number on the page.',
      'Check the Reply queue first — these people are waiting for an answer.',
      'Look at WhatsApp number health — red means messages may not be reaching people.',
    ],
    sections: [
      {
        title: 'What each box means',
        items: [
          { label: 'Message volume', text: 'How many messages came in and went out each day.' },
          { label: 'Reply queue', text: 'Conversations waiting for your reply, longest wait first. Click one to open it in the Inbox.' },
          { label: 'Pipeline', text: 'Open deals and their value, grouped by stage.' },
          { label: 'Team', text: 'How many replies each team member sent in this period.' },
          { label: 'Campaigns and automations', text: 'Broadcasts sent and automations that ran in this period.' },
          { label: 'WhatsApp number health', text: 'The quality rating and sending limit of your number. Keep it green by not spamming.' },
          { label: 'Failed messages', text: 'Messages WhatsApp could not deliver in the last 24 hours — fix them on the Failed messages page.' },
        ],
      },
    ],
    tips: ['Callers see a simpler dashboard with only their own leads and callbacks.', 'If a number looks wrong, refresh — the dashboard updates live.'],
  },

  inbox: {
    title: 'Inbox',
    tagline: 'Every WhatsApp chat with your customers. Read, reply, assign and close conversations.',
    steps: [
      'Pick a chat from the list on the left.',
      'Type your reply at the bottom and press Send. Use the template button when the 24h window is closed.',
      'Assign the chat to a team member so everyone knows who is handling it.',
      'Set the status to Closed when the conversation is finished.',
    ],
    sections: [
      {
        title: 'Filters (top of the chat list)',
        items: [
          { label: 'All', text: 'Every conversation.' },
          { label: 'Unread', text: 'Chats with messages nobody has opened yet.' },
          { label: 'Open', tone: 'emerald', text: 'Active conversations that need attention.' },
          { label: 'Pending', tone: 'amber', text: 'Waiting on something — e.g. you asked the customer a question.' },
          { label: 'Closed', tone: 'muted', text: 'Finished conversations. A new message from the customer re-opens it.' },
          { label: 'Waiting for reply', tone: 'amber', text: 'The customer wrote last — they are waiting for you.' },
          { label: 'Unassigned', text: 'Nobody is handling these yet.' },
          { label: 'Reply window closing', tone: 'rose', text: 'Less than a few hours left before you can only send templates.' },
        ],
      },
      {
        title: 'Inside a chat',
        items: [
          { label: 'Assign', text: 'Give the chat to a team member. For callers this also makes them the lead’s owner.' },
          { label: 'Tags', text: 'Labels on the contact (see the tag list below). Add or remove them from the contact panel.' },
          { label: 'Notes', text: 'Private notes for the team — the customer never sees them.' },
          { label: 'AI draft', text: 'If the AI agent is on, it can suggest a reply. Always read it before sending.' },
        ],
      },
    ],
    tips: [WINDOW_TIP, 'Callers only see chats of their own leads.'],
    tags: true,
  },

  contacts: {
    title: 'Contacts',
    tagline: 'Your full list of people — everyone who messaged you, registered, or was imported.',
    steps: [
      'Search by name or phone, or filter by tag.',
      'Click a contact to see their details, notes, deals and history.',
      'Use Import to add many contacts at once from a CSV (Excel) file.',
    ],
    sections: [
      {
        title: 'Tabs inside a contact',
        items: [
          { label: 'Details', text: 'Name, phone, email, company.' },
          { label: 'Activity', text: 'Everything that happened — messages, tags, journey steps.' },
          { label: 'Notes', text: 'Private team notes about this person.' },
          { label: 'Custom fields', text: 'Extra information your business stores (city, course, etc.).' },
          { label: 'Deals', text: 'Sales opportunities linked to this person.' },
          { label: 'Tags', text: 'Labels that group people and drive automatic messages.' },
        ],
      },
    ],
    tips: ['Removing a tag can change what automatic messages someone gets — be careful with system tags.', 'Callers see only the contacts of leads assigned to them.'],
    tags: true,
  },

  pipelines: {
    title: 'Pipelines',
    tagline: 'Track sales deals as cards moving across stages, from first contact to won.',
    steps: [
      'Each column is a stage (e.g. New → Talking → Won).',
      'Drag a card to move a deal to the next stage.',
      'Click a card to edit its value, contact or status.',
    ],
    sections: [
      {
        title: 'Deal status',
        items: [
          { label: 'Open', tone: 'sky', text: 'Still in progress.' },
          { label: 'Won', tone: 'emerald', text: 'The customer bought.' },
          { label: 'Lost', tone: 'rose', text: 'The customer did not buy.' },
        ],
      },
    ],
    tips: ['The Dashboard shows the total value of open deals per stage.'],
  },

  callbacks: {
    title: 'Callback requests',
    tagline: 'People waiting for your call. Call them, then tap what happened.',
    steps: [
      'Start with the big “Call next” card at the top — it is always the most important person to call.',
      'Tap the green Call button (or the number) to dial.',
      'After the call, tap what happened: Spoke to them, Didn\x27t pick up or All done — then Add note.',
      'Tap Details to see everything about the lead and their timeline.',
    ],
    sections: [
      {
        title: 'Show (tabs)',
        items: [
          { label: 'To call', tone: 'amber', text: 'Everything not finished yet (Waiting + Spoke to them + Didn\x27t pick up).' },
          { label: '🔥 Priority', tone: 'amber', text: 'Only customers who asked for a call themselves and are still waiting. The number shows how many. Call these first.' },
          { label: 'Not called yet', tone: 'amber', text: 'Nobody has called yet.' },
          { label: 'Spoke to them', tone: 'sky', text: 'You spoke to them, but there is still something to do.' },
          { label: 'Didn\x27t pick up', tone: 'rose', text: 'You called and they did not pick up.' },
          { label: 'Done', tone: 'emerald', text: 'Finished. The callback_requested tag is removed.' },
          { label: 'Everything', text: 'Every request.' },
          { label: 'When: Today / Yesterday / Last 7 days', text: 'Show only requests made in that period.' },
          { label: 'Show more', text: '10 people are shown at a time — tap Show more to see the next ones.' },
        ],
      },
      {
        title: 'Labels on a card',
        items: [
          { label: '🔥 Customer asked for a call', tone: 'amber', text: 'Priority — call these first. It stops being Priority once you tap Spoke to them or All done, or add a note (Didn\x27t pick up keeps it Priority). If the customer asks again, it becomes Priority again.' },
          { label: '⏰ Waiting 2+ hours', tone: 'rose', text: 'Nobody has called yet and they asked more than 2 hours ago.' },
          { label: '📅 Call at …', tone: 'sky', text: 'The time the customer asked to be called. Turns red when it is time.' },
          { label: 'Asked in chat', tone: 'violet', text: 'The customer wrote “call me” in a message and the AI noticed it. Shows the time they asked for, if any.' },
          { label: 'Check the chat first', tone: 'amber', text: 'The AI was not sure it was a callback request — read the chat before calling.' },
          { label: 'New lead', text: 'A new website lead given to a caller to call.' },
          { label: 'Caller name', text: 'Who this lead belongs to.' },
          { label: 'Didn\x27t pick up ×2', tone: 'rose', text: 'How many times the call was not answered.' },
          { label: 'Coloured line on the left', text: 'Shows the status at a glance (amber waiting, blue spoke to them, red didn\x27t pick up, green done).' },
        ],
      },
      {
        title: 'Buttons',
        items: [
          { label: 'Call', tone: 'emerald', text: 'Dial the number from your phone.' },
          { label: 'Open chat', text: 'See the WhatsApp conversation.' },
          { label: 'Spoke to them', text: 'You talked to the customer.' },
          { label: 'Didn\x27t pick up', text: 'They did not answer. They get a “we tried calling you” WhatsApp message. After the 2nd time they get the normal follow-up messages instead of calls.' },
          { label: 'All done', text: 'Close the request.' },
          { label: 'Add note', text: 'Write what was said. Every note is kept in the timeline — older notes are never lost.' },
          { label: 'Reopen', text: 'On Done requests. Moves it back to Waiting and resets the didn\x27t-pick-up count.' },
          { label: 'Send payment link', tone: 'primary', text: 'Sends the payment link on WhatsApp right away, at any stage. It is added to the timeline and the lead is tagged payment_link_sent.' },
          { label: 'Stop calling — send messages instead', text: 'The lead goes back to the automatic follow-up messages and the request is closed.' },
          { label: 'Delete', tone: 'rose', text: 'Admins only. Moves the request to the Trash with its notes and timeline.' },
          { label: 'Trash', text: 'Admins only. Deleted requests — Restore puts one back exactly as it was, or Delete forever.' },
        ],
      },
      {
        title: 'Details panel (click a card)',
        items: [
          { label: 'Quick facts', text: 'When they asked, who handles them, missed calls, how many times they asked, how they asked.' },
          { label: 'Tags', text: 'All labels on this lead.' },
          { label: 'Timeline', text: 'Everything in order: requests, Spoke to them / Didn\x27t pick up / Done, notes with who wrote them, and payment links sent.' },
        ],
      },
    ],
    tips: [
      'If the same person asks again after Done, the request opens again automatically.',
      'Send payment link uses a normal message if they wrote in the last 24 hours, otherwise the approved “general update” template.',
      'Callers see only their own leads’ requests.',
    ],
    tags: true,
  },

  callers: {
    title: 'Callers',
    tagline: 'Who calls the leads, and how new leads are shared between them.',
    steps: [
      'Add team members as callers.',
      'Turn on “Takes new leads” for everyone who should get new leads today.',
      'New website leads are shared in turn (one each, round-robin) between callers taking leads.',
      'Use “Move leads in bulk” when someone is on leave or leaves the team.',
    ],
    sections: [
      {
        title: 'Numbers at the top',
        items: [
          { label: 'Active callers', text: 'Callers who are switched on.' },
          { label: 'Taking new leads', tone: 'emerald', text: 'Callers who will receive the next new leads.' },
          { label: 'Assigned open leads', text: 'Leads currently owned by a caller and not finished.' },
          { label: 'Admin unassigned', tone: 'amber', text: 'Leads with no owner — e.g. a lead was taken off a caller without a new owner. Give them to someone.' },
        ],
      },
      {
        title: 'Rules the system follows',
        items: [
          { label: 'Returning lead', text: 'If a person registers again, they go back to the same caller (if that caller is still active).' },
          { label: '15-day rule', text: 'Registering again within 15 days does not count as a brand-new lead.' },
          { label: 'Member leaves', text: 'Their leads are released so they can be given to someone else.' },
          { label: 'Takes new leads (off)', text: 'The caller keeps current leads but gets no new ones — use it for leave or busy days.' },
        ],
      },
    ],
    tips: ['The owner/admin does not need to be a caller. Add yourself only if you also take calls.', 'Assigning a chat in the Inbox also makes that person the lead’s owner.'],
  },

  webinars: {
    title: 'Webinar schedule',
    tagline: 'The dates and times of your webinars. New registrations are booked into these sessions automatically.',
    steps: [
      'Add sessions: pick dates and a time (or use the default times).',
      'Add a Zoom link to a session if it differs from the main link.',
      'Need to change a day? Use Edit (new time) or Cancel. You always see how many people are affected before anything happens.',
    ],
    sections: [
      {
        title: 'Session labels',
        items: [
          { label: 'Scheduled', tone: 'emerald', text: 'Will happen. Leads can be booked into it.' },
          { label: 'Cancelled', tone: 'rose', text: 'Will not happen. Booked people were moved to the next session.' },
          { label: 'Booked', text: 'How many people are waiting for this session.' },
        ],
      },
      {
        title: 'Coloured messages on the page',
        items: [
          { label: 'Red box', tone: 'rose', text: 'The system is not following the schedule yet. Changes are blocked until it is fixed.' },
          { label: 'Amber box', tone: 'amber', text: 'A warning — e.g. the “session changed” template is not approved, so moved people won’t get that message.' },
          { label: 'Blue box', tone: 'sky', text: 'Some people are booked into a time that is not on the schedule. Use “Move them”.' },
          { label: 'Few sessions left', tone: 'amber', text: 'Fewer than 3 upcoming sessions — add more so new registrations have a slot.' },
        ],
      },
      {
        title: 'When you cancel or change a time',
        items: [
          { label: 'Preview', text: 'Shows how many people are booked, where they will go, and how many WhatsApp messages will be sent.' },
          { label: 'Moving', text: 'Booked people move to the next scheduled session in the background (about a minute). Progress shows under “Lead moves”.' },
          { label: 'Message', text: 'Each moved person gets ONE “session changed” message with the new date, time and link. Their reminders are re-timed.' },
          { label: 'Not allowed', tone: 'rose', text: 'Changing a session that already started, a time in the past, or less than 30 minutes ahead, or cancelling with no later session.' },
          { label: 'Change history', text: 'Who changed what and how many people it affected.' },
        ],
      },
      {
        title: 'Timing rules',
        items: [
          { label: 'Cut-off', text: 'Registrations after this time go to the next day’s session.' },
          { label: 'Reminder 2 / 3', text: 'How many minutes before the session the reminders are sent.' },
          { label: 'Check-in hour', text: 'When the “how was the webinar?” message is sent after the session.' },
        ],
      },
    ],
    tips: ['All times are India time (IST).', 'Cancel a session as early as possible so people get the change message in time.'],
  },

  payments: {
    title: 'Payments',
    tagline: 'Leads who got the payment link. Record who paid — their payment reminders stop automatically.',
    steps: [
      'Find the person (search or tabs).',
      'Click Mark paid and choose Full payment or Advance payment, with the amount.',
      'Advance payment? The balance due is shown — add the rest when they pay it.',
    ],
    sections: [
      {
        title: 'Tabs',
        items: [
          { label: 'Not paid yet', tone: 'amber', text: 'Got the link, has not paid.' },
          { label: 'Paid', tone: 'emerald', text: 'Paid in full or part.' },
          { label: 'Not proceeding', tone: 'muted', text: 'Decided not to buy.' },
          { label: 'All', text: 'Everyone.' },
        ],
      },
      {
        title: 'Payment types',
        items: [
          { label: 'Full payment', tone: 'emerald', text: 'Paid the whole amount.' },
          { label: 'Advance', tone: 'sky', text: 'Paid part of the amount.' },
          { label: 'Balance due', tone: 'amber', text: 'What is still left to pay after an advance.' },
        ],
      },
      {
        title: 'Numbers at the top',
        items: [
          { label: 'Waiting for payment', text: 'People with the link who have not paid.' },
          { label: 'Paid', text: 'People who paid.' },
          { label: 'Collected', text: 'Total money recorded.' },
          { label: 'Paid rate', text: 'Out of everyone who got the link, how many paid.' },
        ],
      },
    ],
    tips: [
      'Every payment entry can be edited if a mistake was made.',
      'Only admins can delete a payment. It goes to the Trash (button at the top) and can be restored from there.',
      'Admins can download everything as a CSV (Excel) file.', 'Marking paid adds the paid tag and stops sales messages.'],
    tags: true,
  },

  journeys: {
    title: 'Journeys',
    tagline: 'Automatic WhatsApp message sequences — e.g. registration → reminders → webinar → follow-ups.',
    steps: [
      'Open a journey to see its steps as a map.',
      'Each box is a step: send a message, wait, check a reply, add a tag…',
      'Run history shows every person in the journey and what they received.',
    ],
    sections: [
      {
        title: 'Journey status',
        items: [
          { label: 'Active', tone: 'emerald', text: 'Running — new people enter it.' },
          { label: 'Paused', tone: 'amber', text: 'Stopped for now; people inside wait.' },
          { label: 'Draft', tone: 'muted', text: 'Not running yet.' },
        ],
      },
      {
        title: 'Run status (one per person)',
        items: [
          { label: 'Running', tone: 'sky', text: 'Doing a step right now.' },
          { label: 'Waiting', tone: 'amber', text: 'Waiting for a time (e.g. reminder) or for the person to reply.' },
          { label: 'Completed', tone: 'emerald', text: 'Reached the end.' },
          { label: 'Exited', tone: 'muted', text: 'Left early — e.g. paid, closed, or restarted after registering again.' },
          { label: 'Failed', tone: 'rose', text: 'Something went wrong — open it to see why.' },
        ],
      },
      {
        title: 'The webinar journey in simple words',
        items: [
          { label: '1. Registration', text: 'Confirmation message with date, time and link.' },
          { label: '2. Reminders', text: 'Reminders before the session.' },
          { label: '3. After the webinar', text: 'Check-in message with buttons (join, payment, testimonials, call me…).' },
          { label: '4. Follow-ups', text: 'Every 2 days for up to 15 days, until they pay, close or say no.' },
          { label: 'Payment link', text: 'Sent at most once automatically — or when the person asks for it.' },
        ],
      },
    ],
    tips: ['Ask your admin before editing a live journey — changes affect everyone in it.', 'Templates used in a journey must be approved by WhatsApp.'],
    tags: true,
  },

  broadcasts: {
    title: 'Broadcasts',
    tagline: 'Send one message to many people at once, using approved templates.',
    steps: [
      'Click New broadcast.',
      'Choose a template and who should receive it (all, or by tag).',
      'Send now or schedule a time.',
      'Open a broadcast to see who got and read it.',
    ],
    sections: [
      {
        title: 'Broadcast status',
        items: [
          { label: 'Draft', tone: 'muted', text: 'Saved, not sent.' },
          { label: 'Scheduled', tone: 'sky', text: 'Will be sent at the chosen time.' },
          { label: 'Sending', tone: 'amber', text: 'Going out now.' },
          { label: 'Sent', tone: 'emerald', text: 'Finished.' },
          { label: 'Failed / Cancelled', tone: 'rose', text: 'Did not go out.' },
        ],
      },
      {
        title: 'Per person',
        items: [
          { label: 'Sent', text: 'Left our system.' },
          { label: 'Delivered', tone: 'sky', text: 'Reached their phone.' },
          { label: 'Read', tone: 'emerald', text: 'They opened it (only if read receipts are on).' },
          { label: 'Replied', tone: 'violet', text: 'They answered.' },
          { label: 'Failed', tone: 'rose', text: 'Not delivered — see the error.' },
        ],
      },
    ],
    tips: ['Marketing templates cost more than Utility templates.', 'Too many blocks or reports can lower your number’s quality — send only to people who expect it.'],
  },

  automations: {
    title: 'Automations',
    tagline: 'Simple “when this happens, do that” rules — e.g. when a tag is added, send a message.',
    steps: ['Pick a trigger (what starts it).', 'Add actions (what it does).', 'Turn it on and check the execution logs.'],
    sections: [
      {
        title: 'Log results',
        items: [
          { label: 'success', tone: 'emerald', text: 'All actions worked.' },
          { label: 'partial', tone: 'amber', text: 'Some actions worked, some did not.' },
          { label: 'failed', tone: 'rose', text: 'Nothing was done — open the log to see why.' },
        ],
      },
    ],
    tips: ['For long multi-step sequences use Journeys instead.'],
  },

  flows: {
    title: 'Flows',
    tagline: 'Button menus inside WhatsApp — e.g. FAQs or “choose an option” before a human replies.',
    steps: ['Create a flow and add questions with buttons.', 'Connect each button to the next step.', 'Set it Active.'],
    sections: [
      {
        title: 'Flow status',
        items: [
          { label: 'Draft', tone: 'muted', text: 'Not live.' },
          { label: 'Active', tone: 'emerald', text: 'Live for customers.' },
          { label: 'Archived', text: 'Kept for history, not used.' },
        ],
      },
      {
        title: 'Run results',
        items: [
          { label: 'Completed', tone: 'emerald', text: 'Finished the flow.' },
          { label: 'Handed off', tone: 'sky', text: 'Passed to a team member.' },
          { label: 'Timed out', tone: 'amber', text: 'The person stopped answering.' },
          { label: 'Paused by agent', text: 'A team member stepped in.' },
          { label: 'Failed', tone: 'rose', text: 'Something went wrong.' },
        ],
      },
    ],
    tips: [],
  },

  'button-clicks': {
    title: 'Button clicks',
    tagline: 'Which buttons people tap in your WhatsApp messages — and who tapped them.',
    steps: ['Pick a period.', 'Click a button name to see the people who tapped it.', 'Open a chat to follow up.'],
    sections: [],
    tips: ['Lots of taps on “Request a callback” or “Join” = hot leads — call them quickly.'],
  },

  'failed-messages': {
    title: 'Failed messages',
    tagline: 'Messages that did not reach people — resend, schedule, send a custom text, or dismiss.',
    steps: ['Open the Messages tab.', 'Read the reason chip to see why it failed.', 'Resend, send a custom text (if their 24h window is open), or dismiss.'],
    sections: [
      {
        title: 'Tabs & labels',
        items: [
          { label: 'Messages', text: 'Messages WhatsApp could not deliver.' },
          { label: 'Skipped registrations', tone: 'amber', text: 'Website registrations that could not be added (e.g. wrong number). Fix and add them.' },
          { label: 'Still failed', tone: 'rose', text: 'Not handled yet.' },
          { label: 'Handled', tone: 'emerald', text: 'Resent or dismissed.' },
          { label: '24h window open', tone: 'sky', text: 'You can send them a normal text right now.' },
        ],
      },
    ],
    tips: [WINDOW_TIP],
  },

  notifications: {
    title: 'Notifications',
    tagline: 'Alerts for you — chats assigned to you, priority callbacks, new leads and more.',
    steps: ['Click a notification to open it.', 'Allow browser notifications so you hear a sound even when the tab is in the background.'],
    sections: [
      {
        title: 'Sounds',
        items: [
          { label: 'Priority sound', tone: 'amber', text: 'A customer asked for a call — handle it first.' },
          { label: 'Normal sound', text: 'Other updates.' },
        ],
      },
    ],
    tips: ['Priority alerts appear at the top.'],
  },

  agents: {
    title: 'AI agent',
    tagline: 'The AI that drafts or sends replies in WhatsApp using your business knowledge.',
    steps: ['Setup: choose the AI model and add your business information (FAQ, prices, testimonials).', 'Playground: test it by chatting as a customer.', 'Turn on auto-reply only when the answers look right.'],
    sections: [
      {
        title: 'Tabs',
        items: [
          { label: 'Playground', text: 'Try it safely — nothing is sent to customers.' },
          { label: 'Setup', text: 'Model, backup (fallback) model, instructions and knowledge.' },
          { label: 'Usage', text: 'How much AI was used (no message content is stored here).' },
        ],
      },
      {
        title: 'Good to know',
        items: [
          { label: 'Backup model', text: 'If the main AI is down or busy, the backup answers instead.' },
          { label: 'Formatting', text: 'Replies use WhatsApp style (*bold*), never **double stars**.' },
          { label: 'Callback detection', text: 'When someone types “call me”, the AI creates a callback request.' },
        ],
      },
    ],
    tips: ['Keep the knowledge short and up to date — the AI only knows what you give it.'],
  },

  settings: {
    title: 'Settings',
    tagline: 'Set up your WhatsApp number, templates, team, tags and other options.',
    steps: ['Pick a section on the left.', 'Make your change and click Save.'],
    sections: [
      {
        title: 'Main sections',
        items: [
          { label: 'Your profile / Login & security', text: 'Your name, photo and password.' },
          { label: 'WhatsApp', text: 'The connected phone number and its health.' },
          { label: 'Templates', text: 'Pre-approved WhatsApp messages (needed outside the 24h window). Also carousels.' },
          { label: 'Quick replies', text: 'Saved answers you can insert in the Inbox with a shortcut.' },
          { label: 'Fields & tags', text: 'Create tags and extra contact fields.' },
          { label: 'Deals & currency', text: 'Pipeline stages and the currency for amounts.' },
          { label: 'Team members', text: 'Invite people, share the invite link, set roles, and choose which modules each role can see or edit (e.g. Callers, Webinars).' },
          { label: 'Smart sending', text: 'Sending speed and safety limits for bulk messages.' },
          { label: 'Callback reminders', text: 'How often the team is reminded about waiting callbacks, and in which hours.' },
          { label: 'Inbox', text: 'Inbox options such as the 24h window keep-alive.' },
          { label: 'API keys', text: 'For connecting other software (technical — leave to your admin).' },
        ],
      },
      {
        title: 'Template status',
        items: [
          { label: 'Approved', tone: 'emerald', text: 'Ready to use.' },
          { label: 'Pending', tone: 'amber', text: 'WhatsApp is reviewing it (minutes to a day).' },
          { label: 'Rejected', tone: 'rose', text: 'Not allowed — change the wording and submit again.' },
          { label: 'Utility vs Marketing', text: 'Utility (updates, reminders) is cheaper. Marketing (offers, promotions) costs more.' },
        ],
      },
    ],
    tips: ['Invite links work for many people. New members create an account and log in — no email confirmation needed.'],
  },

  admin: {
    title: 'Admin',
    tagline: 'Super-admin tools for managing workspaces and users.',
    steps: ['Find the user or workspace.', 'Use Move to put a user into the right workspace.'],
    sections: [],
    tips: ['Only super-admins can open this page.'],
  },
};
