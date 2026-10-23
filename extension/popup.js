chrome.storage.local.get(["pages", "sent", "last", "paused"], (s) => {
  document.getElementById("pages").textContent = s.pages || 0;
  document.getElementById("sent").textContent = s.sent || 0;
  document.getElementById("last").textContent = s.last ? new Date(s.last).toLocaleString("pt-BR") : "–";
  const p = document.getElementById("paused");
  p.checked = !!s.paused;
  p.onchange = () => chrome.storage.local.set({ paused: p.checked });
});

chrome.storage.local.get("key", (s) => {
  const k = document.getElementById("key"), m = document.getElementById("kmsg");
  m.textContent = s.key ? "Chave salva." : "Sem chave: a extensão não grava nada ainda.";
  document.getElementById("save").onclick = () => { const v = k.value.trim(); if (!/^[a-f0-9]{32}$/.test(v)) { m.textContent = "Chave inválida (32 letras e números)."; return; } chrome.storage.local.set({ key: v }, () => { k.value = ""; m.textContent = "Chave salva."; }); };
});
