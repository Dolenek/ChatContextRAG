const MESSAGE_EXTRACTION_HELPERS = `
  const isVisible = (element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.height > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight;
  };
  const findAuthor = (messageGroup) => {
    const localAuthor = messageGroup.querySelector('[id^="message-username-"]');
    if (localAuthor?.innerText?.trim()) return localAuthor.innerText.trim();
    let previousGroup = messageGroup.previousElementSibling;
    while (previousGroup) {
      const author = previousGroup.querySelector?.('[id^="message-username-"]');
      if (author?.innerText?.trim()) return author.innerText.trim();
      previousGroup = previousGroup.previousElementSibling;
    }
    return 'Neznámý autor';
  };
  const extractContent = (messageGroup) => {
    const text = messageGroup.querySelector('[id^="message-content-"]')?.innerText?.trim();
    if (text) return text;
    const embed = messageGroup.querySelector('[class*="embedFull"], article')?.innerText?.trim();
    if (embed) return embed;
    const attachment = messageGroup.querySelector('a[download], [class*="attachment"] a')?.innerText?.trim();
    return attachment ? '[Příloha] ' + attachment : '[Příloha nebo zpráva bez textu]';
  };
  const extractMessages = (groups) => {
    const channel = document.querySelector('h1')?.innerText?.trim() || document.title;
    return groups.map((group) => ({
      external_id: group.id.split('-').pop(),
      author: findAuthor(group),
      content: extractContent(group),
      timestamp: group.querySelector('time')?.getAttribute('datetime') || null,
      channel,
    })).filter((message) => message.content);
  };
`;

const SCROLLER_HELPER = `
  const findMessageScroller = (firstMessage) => {
    let scroller = firstMessage?.parentElement;
    while (scroller) {
      const overflowY = getComputedStyle(scroller).overflowY;
      const scrollable = scroller.scrollHeight > scroller.clientHeight + 50;
      if (scrollable && (overflowY === 'scroll' || overflowY === 'auto')) return scroller;
      scroller = scroller.parentElement;
    }
    return null;
  };
`;

function buildDiscordExtractionScript() {
  return `(() => {
    ${MESSAGE_EXTRACTION_HELPERS}
    const groups = [...document.querySelectorAll('li[id^="chat-messages-"]')]
      .filter(isVisible).slice(-4);
    return extractMessages(groups);
  })()`;
}

function buildDiscordScanObservationScript() {
  return `(() => {
    ${MESSAGE_EXTRACTION_HELPERS}
    ${SCROLLER_HELPER}
    const groups = [...document.querySelectorAll('li[id^="chat-messages-"]')].slice(-100);
    const firstMessage = groups[0];
    const scroller = findMessageScroller(firstMessage);
    if (!scroller) return { error: 'Scroll kontejner zpráv nebyl nalezen.' };
    const scrollTopBefore = scroller.scrollTop;
    return {
      messages: extractMessages(groups), atTop: scrollTopBefore <= 2, scrollTopBefore,
      topMessageId: firstMessage?.id || null,
    };
  })()`;
}

function buildDiscordScrollUpScript() {
  return `(() => {
    ${SCROLLER_HELPER}
    const firstMessage = document.querySelector('li[id^="chat-messages-"]');
    const scroller = findMessageScroller(firstMessage);
    if (!scroller) return { error: 'Scroll kontejner zpráv nebyl nalezen.' };
    const distance = Math.max(scroller.clientHeight * 0.85, 450);
    scroller.scrollTop = Math.max(0, scroller.scrollTop - distance);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { requestedScrollTop: scroller.scrollTop };
  })()`;
}

module.exports = {
  buildDiscordExtractionScript, buildDiscordScanObservationScript, buildDiscordScrollUpScript,
};
