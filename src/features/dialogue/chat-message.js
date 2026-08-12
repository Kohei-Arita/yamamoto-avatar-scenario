export function getMessageText(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item?.type === "text") {
          return item.text || "";
        }

        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

export function getLastUserMessage(messages = []) {
  const lastUserMessage = [...messages].reverse().find((message) => message?.role === "user");
  return getMessageText(lastUserMessage?.content);
}

export function replaceLastUserMessage(messages = [], content) {
  const lastUserIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find((entry) => entry.message?.role === "user")?.index;

  if (lastUserIndex === undefined) {
    return messages;
  }

  return messages.map((message, index) =>
    index === lastUserIndex
      ? {
          ...message,
          content
        }
      : message
  );
}
