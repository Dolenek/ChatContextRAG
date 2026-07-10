function buildDiscordExtractionScript() {
  return `(() => {
    const isVisible = (element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.height > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight;
    };
    const messageGroups = [...document.querySelectorAll('li[id^="chat-messages-"]')]
      .filter(isVisible)
      .slice(-4);
    const findAuthor = (messageGroup) => {
      const localAuthor = messageGroup.querySelector('[id^="message-username-"]');
      if (localAuthor?.innerText?.trim()) return localAuthor.innerText.trim();
      let previousGroup = messageGroup?.previousElementSibling;
      while (previousGroup) {
        const author = previousGroup.querySelector?.('[id^="message-username-"]');
        if (author?.innerText?.trim()) return author.innerText.trim();
        previousGroup = previousGroup.previousElementSibling;
      }
      return 'Neznámý autor';
    };
    const extractContent = (messageGroup) => {
      const messageText = messageGroup.querySelector('[id^="message-content-"]')?.innerText?.trim();
      if (messageText) return messageText;
      const embedText = messageGroup.querySelector('[class*="embedFull"], article')?.innerText?.trim();
      if (embedText) return embedText;
      const attachmentName = messageGroup.querySelector('a[download], [class*="attachment"] a')?.innerText?.trim();
      return attachmentName ? '[Příloha] ' + attachmentName : '[Příloha nebo zpráva bez textu]';
    };
    const channel = document.querySelector('h1')?.innerText?.trim() || document.title;
    return messageGroups.map((messageGroup) => {
      const externalId = messageGroup.id.split('-').pop();
      const timestamp = messageGroup?.querySelector('time')?.getAttribute('datetime') || null;
      return {
        external_id: externalId,
        author: findAuthor(messageGroup),
        content: extractContent(messageGroup),
        timestamp,
        channel,
      };
    }).filter((message) => message.content);
  })()`;
}

module.exports = { buildDiscordExtractionScript };
