import { useEffect, useRef, useState } from "react";

/* -------------------------------------------------------
   WAV ENCODING HELPERS (your original logic)
--------------------------------------------------------*/
async function toWavBlob(audioChunks) {
  const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
  const arrayBuffer = await audioBlob.arrayBuffer();

  const audioCtx = new AudioContext();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const bitDepth = 16;

  let samples;
  if (numChannels === 2) {
    samples = interleave(
      audioBuffer.getChannelData(0),
      audioBuffer.getChannelData(1)
    );
  } else {
    samples = audioBuffer.getChannelData(0);
  }

  const wavData = encodeWAV(samples, numChannels, sampleRate, bitDepth);
  return new Blob([wavData], { type: "audio/wav" });
}

function interleave(L, R) {
  let length = L.length + R.length;
  let result = new Float32Array(length);
  let index = 0;

  for (let i = 0; i < L.length; i++) {
    result[index++] = L[i];
    result[index++] = R[i];
  }
  return result;
}

function encodeWAV(samples, numChannels, sampleRate, bitDepth) {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, "WAVE");

  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  writeString(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s * 0x7fff, true);
  }

  return view;
}

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/* -------------------------------------------------------
   MAIN APP
--------------------------------------------------------*/

function App() {
  const videoRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const [isRecording, setIsRecording] = useState(false);
  const [loading, setLoading] = useState(false);

  /* -------------------------------------------------------
     UPDATED CAMERA: FORCE BACK CAMERA + FALLBACK
  --------------------------------------------------------*/
  useEffect(() => {
    async function enableCamera() {
      try {
        // Try exact environment camera
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { exact: "environment" } },
          audio: false,
        });
        videoRef.current.srcObject = stream;
      } catch (err) {
        console.warn("Exact back camera not available, using fallback.");
        // Fallback for Safari / older devices
        const fallbackStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        videoRef.current.srcObject = fallbackStream;
      }
    }
    enableCamera();
  }, []);

  const startRecording = async () => {
    audioChunksRef.current = [];

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);
    recorder.start();

    mediaRecorderRef.current = recorder;
    setIsRecording(true);
  };

  const stopRecording = () => {
    if (!isRecording) return;
    setIsRecording(false);

    return new Promise((resolve) => {
      mediaRecorderRef.current.onstop = async () => {
        const wavBlob = await toWavBlob(audioChunksRef.current);

        const canvas = document.createElement("canvas");
        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(videoRef.current, 0, 0);
        const imageBlob = await new Promise((res) =>
          canvas.toBlob(res, "image/jpeg")
        );

        setLoading(true);

        try {
          const formData = new FormData();
          formData.append("image", imageBlob, "frame.jpg");
          formData.append("audio", wavBlob, "audio.wav");

          const backend = await fetch(
            "https://api.derrickwzb.app/analyze",
            {
              method: "POST",
              body: formData,
            }
          );

          const backendJson = await backend.json();
          console.log("FULL BACKEND RESPONSE:", backendJson);

          const textResponse = backendJson.text;

          if (!textResponse) {
            console.error("❌ Backend returned no text field");
            return;
          }

          console.log("Final textResponse:", textResponse);

          const groqRes = await fetch(
            "https://api.groq.com/openai/v1/audio/speech",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${import.meta.env.VITE_GROQ_API_KEY}`,
              },
              body: JSON.stringify({
                model: "playai-tts",
                voice: "Fritz-PlayAI",
                input: textResponse,
                response_format: "wav",
              }),
            }
          );

          if (!groqRes.ok) {
            console.error("Groq error:", await groqRes.text());
            return;
          }

          const audioBuffer = await groqRes.arrayBuffer();
          playAudio(audioBuffer);

        } catch (err) {
          console.error(err);
        }

        setLoading(false);
        resolve();
      };

      mediaRecorderRef.current.stop();
    });
  };

  const playAudio = async (arrayBuffer) => {
    const audioContext = new AudioContext();
    const decoded = await audioContext.decodeAudioData(arrayBuffer);
    const source = audioContext.createBufferSource();
    source.buffer = decoded;
    source.connect(audioContext.destination);
    source.start();
  };

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>AIEyes</h1>

      <div style={styles.centerContainer}>
        <video ref={videoRef} autoPlay playsInline style={styles.video} />

        <button
          style={{
            ...styles.button,
            backgroundColor: isRecording ? "#ff3333" : "#4CAF50",
          }}
          onMouseDown={startRecording}
          onMouseUp={stopRecording}
          onTouchStart={startRecording}
          onTouchEnd={stopRecording}
          disabled={loading}
        >
          {loading
            ? "Processing..."
            : isRecording
            ? "Recording..."
            : "Press & Hold to Speak"}
        </button>
      </div>
    </div>
  );
}

export default App;

/* -------------------------------------------------------
   UPDATED UI STYLES
--------------------------------------------------------*/
const styles = {
  page: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    height: "100vh",
    background: "#111",
  },

  title: {
    color: "white",
    fontSize: "36px",
    marginBottom: "20px",
    fontWeight: "600",
  },

  centerContainer: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "30px",
  },

  video: {
    width: "95%",
    maxWidth: "500px",
    borderRadius: "16px",
    border: "3px solid #333",
  },

  button: {
    padding: "30px 70px",
    borderRadius: "16px",
    color: "white",
    fontSize: "24px",
    fontWeight: "600",
    border: "none",
    cursor: "pointer",
    transition: "0.2s",
  },
};
