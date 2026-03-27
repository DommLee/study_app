# 🎓 OmniTutor v3

**Document-grounded AI study workspace.**

OmniTutor, yüklediğin dokümanlardan yapay zekâ destekli sohbet, quiz ve flashcard üreten kişisel çalışma asOmniTutor answers from uploaded source files only. Chat, quiz, and flashcards stay locked to the indexed documents in the active session.

<p align="center">
  <img src="public/assets/screenshot1.png" alt="OmniTutor Dashboard Ekran Görüntüsü" width="800" />
  <br/>
  <em>OmniTutor Çalışma Paneli</em>
</p>

<p align="center">
  <img src="public/assets/screenshot2.png" alt="OmniTutor Chat Ekran Görüntüsü" width="800" />
  <br/>
  <em>Dokümanlarla Sohbet</em>
</p>

---

## ✨ Özellikler

| Özellik | Açıklama |
|---------|----------|
| 💬 Dokümana dayalı sohbet | Yüklenen dosyalar üzerinden soru-cevap |
| 📝 Quiz & Flashcard | Otomatik quiz ve flashcard oluşturma |
| 🤖 Çoklu AI sağlayıcı | Ollama, Gemini, OpenAI, Groq, DeepSeek, Custom |
| 📄 Dosya desteği | PDF, TXT, MD, PNG, JPG, WEBP, PPT/PPTX |
| ⏱️ Pomodoro zamanlayıcı | Odaklanma modu ile verimli çalışma |
| 📊 İlerleme panosu | Çalışma istatistikleri takibi |
| 💾 Oturum kaydetme | Oturumlar diskte kalıcı olarak saklanır |

---

## 🚀 Kurulum Rehberi (Adım Adım)

Projeyi kendi bilgisayarında çalıştırmak için aşağıdaki yöntemlerden birini seç.

### Gereksinimler

Başlamadan önce bunlardan **en az birini** kur:

| Araç | İndirme Linki | Açıklama |
|------|---------------|----------|
| **Git** | [git-scm.com](https://git-scm.com/downloads) | Repoyu klonlamak için |
| **Node.js** (v18+) | [nodejs.org](https://nodejs.org/) | Yöntem 1 için gerekli |
| **Docker Desktop** | [docker.com](https://www.docker.com/products/docker-desktop/) | Yöntem 2 için gerekli |

---

### 📦 Yöntem 1: Node.js ile Kurulum (Kolay)

Docker bilmiyorsan bu yöntemi kullan. En basit yol budur.

#### Adım 1 — Node.js Kur
[nodejs.org](https://nodejs.org/) adresinden **LTS** sürümünü indir ve kur.
Kurulumu doğrulamak için terminali aç ve şunu yaz:
```powershell
node --version
npm --version
```
İkisi de versiyon numarası veriyorsa kurulum tamamdır.

#### Adım 2 — Repoyu Klonla
```powershell
git clone https://github.com/DommLee/study_app.git
cd study_app
```

#### Adım 3 — Bağımlılıkları Kur
```powershell
npm install
```

#### Adım 4 — Ortam Değişkenlerini Ayarla
`.env.example` dosyasını kopyalayarak `.env` dosyası oluştur:
```powershell
copy .env.example .env
```
Sonra `.env` dosyasını herhangi bir text editörle aç ve API anahtarını yaz:
```env
# Gemini kullanmak istiyorsan:
GEMINI_API_KEY=senin_api_key_in

# Veya Ollama kullanmak istiyorsan (lokal AI):
AI_PROVIDER=ollama
```

> **💡 İpucu:** API anahtarı almak için:
> - **Gemini:** [aistudio.google.com](https://aistudio.google.com/apikey) → Ücretsiz API key al
> - **Groq:** [console.groq.com](https://console.groq.com/keys) → Ücretsiz key al
> - **Ollama:** [ollama.com](https://ollama.com/) → İndir ve kur, key gerekmez

#### Adım 5 — Uygulamayı Başlat
```powershell
npm start
```

#### Adım 6 — Tarayıcıda Aç
```
http://localhost:3030
```

✅ **Hepsi bu kadar!** Uygulama çalışıyordur.

---

### 🐳 Yöntem 2: Docker ile Kurulum

Docker biliyorsan bu yöntem daha pratik — hiçbir şey ayrıca kurmana gerek kalmaz.

#### Adım 1 — Docker Desktop Kur
[docker.com](https://www.docker.com/products/docker-desktop/) adresinden indir ve kur.
Kurulduktan sonra Docker Desktop uygulamasını çalıştır.

#### Adım 2 — Repoyu Klonla
```powershell
git clone https://github.com/DommLee/study_app.git
cd study_app
```

#### Adım 3 — Ortam Değişkenlerini Ayarla
```powershell
copy .env.example .env
```
`.env` dosyasını düzenle ve API anahtarını gir (yukarıdaki Yöntem 1, Adım 4'e bak).

#### Adım 4 — Docker ile Başlat
Windows'ta:
```powershell
start.bat
```
Veya doğrudan:
```powershell
docker compose up --build -d
```

#### Adım 5 — Tarayıcıda Aç
```
http://localhost:3030
```

> **📝 Not:** Docker ile Ollama kullanmak istiyorsan, Ollama'yı bilgisayarında ayrıca kur ve çalıştır.
> Docker uygulaması otomatik olarak `host.docker.internal:11434` üzerinden erişir.

---

## ⚙️ Uygulama İçi Ayarlar

Uygulamayı açtıktan sonra **Ayarlar** (⚙️) butonuna tıkla:

1. **AI Sağlayıcı Seç:** Ollama, Gemini, OpenAI, Groq, DeepSeek veya Custom
2. **API Key Gir:** Seçtiğin sağlayıcının key'ini yapıştır
3. **Model Seç:** İstediğin modeli yaz (örn. `gemini-2.0-flash`, `llama3.1`)
4. **Bağlantıyı Test Et:** "Test" butonuna bas, bağlantı çalışıyorsa ✅ göreceksin

---

## 🔑 Ücretsiz API Key Rehberi

| Sağlayıcı | Ücretsiz mi? | Key Alma Linki |
|-----------|:------------:|----------------|
| **Ollama** | ✅ Tamamen ücretsiz (lokal) | [ollama.com](https://ollama.com/) |
| **Gemini** | ✅ Ücretsiz kullanım mevcut | [aistudio.google.com](https://aistudio.google.com/apikey) |
| **Groq** | ✅ Ücretsiz tier mevcut | [console.groq.com](https://console.groq.com/keys) |
| **OpenAI** | ❌ Ücretli | [platform.openai.com](https://platform.openai.com/api-keys) |
| **DeepSeek** | ✅ Çok ucuz | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |

---

## 📖 Nasıl Kullanılır?

1. **Doküman Yükle:** Ana sayfada 📎 butonuna tıkla → PDF, TXT, MD veya resim yükle
2. **Soru Sor:** Yüklediğin doküman hakkında sohbet alanından soru sor
3. **Quiz Oluştur:** Quiz sekmesine geç → Otomatik quiz oluşturulur
4. **Flashcard Çalış:** Flashcard sekmesine geç → Kartları çevirip çalış
5. **Pomodoro Kullan:** Zamanlayıcıyı başlat ve odaklan

---

## 🔧 Sorun Giderme

| Sorun | Çözüm |
|-------|-------|
| `npm install` hata veriyor | Node.js v18+ kurulu mu kontrol et: `node --version` |
| Port 3030 kullanımda | `.env` dosyasında `PORT=3031` yaz |
| API key çalışmıyor | Ayarlarda doğru sağlayıcıyı seçtiğinden emin ol |
| Docker başlamıyor | Docker Desktop açık mı kontrol et |
| Ollama bağlanmıyor | Ollama'nın çalıştığından emin ol: `ollama list` |
| Sayfa açılmıyor | `http://localhost:3030` adresini kontrol et |

---

## 📁 Proje Yapısı

```
study_app/
├── public/            # Frontend dosyaları (HTML, CSS, JS)
├── data/              # Çalışma zamanı verileri ve oturum dosyaları
├── uploads/           # Geçici yükleme klasörü
├── server.js          # Ana sunucu dosyası
├── package.json       # Node.js bağımlılıkları
├── docker-compose.yml # Docker yapılandırması
├── Dockerfile         # Docker image tanımı
├── start.bat          # Windows hızlı başlatma scripti
├── .env.example       # Ortam değişkenleri şablonu
└── system-prompt.md   # AI sistem talimatları
```

---

## 🔒 Güvenlik Notları

- `.env` dosyasını **kimseyle paylaşma**, API key'lerin içinde.
- `data/config.json` dosyası da yerel ayarlarını içerir — commit'leme.
- `.gitignore` dosyası bu hassas dosyaları otomatik olarak yok sayar.
- API key'lerini başkalarıyla paylaştıysan, hemen yenile (rotate et).

---

## 🤝 Katkıda Bulunma

1. Repoyu fork'la
2. Yeni bir branch oluştur: `git checkout -b yeni-ozellik`
3. Değişikliklerini commit'le: `git commit -m "Yeni özellik eklendi"`
4. Push et: `git push origin yeni-ozellik`
5. Pull Request aç

---

## 📋 Ortam Değişkenleri Referansı

| Değişken | Varsayılan | Açıklama |
|----------|-----------|----------|
| `PORT` | `3030` | Sunucu portu |
| `HOST` | `127.0.0.1` | Bağlanma adresi |
| `AI_PROVIDER` | `ollama` | Varsayılan AI sağlayıcı |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama API adresi |
| `OLLAMA_MODEL` | `llama3.1` | Ollama modeli |
| `GEMINI_API_KEY` | — | Google Gemini API anahtarı |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Gemini modeli |
| `OPENAI_API_KEY` | — | OpenAI API anahtarı |
| `GROQ_API_KEY` | — | Groq API anahtarı |
| `DEEPSEEK_API_KEY` | — | DeepSeek API anahtarı |

---

## 🖼️ Ekran Görüntüleri Ekleme

Projeye kendi ekran görüntülerinizi eklemek isterseniz:
1. `public/assets` klasörü oluşturun.
2. Ekran görüntülerinizi `screenshot1.png` ve `screenshot2.png` olarak kaydedin.
3. README'deki görseller otomatik olarak güncellenecektir.

---

## 📝 Lisans

Bu proje [LICENSE](LICENSE) dosyasında belirtilen lisans altında dağıtılmaktadır.

---

<p align="center">
  <b>OmniTutor v3</b> ile iyi çalışmalar! 🚀📚
</p>
