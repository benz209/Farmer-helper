/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { GoogleGenAI } from "@google/genai";
import ReactMarkdown from 'react-markdown';
import { motion } from 'motion/react';
import { 
  Cloud, 
  Droplets, 
  Thermometer, 
  Wind, 
  MapPin, 
  Sprout, 
  ShieldAlert, 
  Info, 
  Search,
  Loader2,
  ChevronRight,
  Sun,
  CloudRain,
  LogOut,
  User as UserIcon,
  Globe,
  Save,
  AlertCircle,
  Camera,
  Upload,
  Bug,
  ExternalLink,
  RefreshCw,
  Pencil,
  X
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  Tooltip, 
  CartesianGrid 
} from 'recharts';
import { Toaster, toast } from 'sonner';
import { TAMIL_NADU_DISTRICTS } from './constants';
import { cn } from './lib/utils';
import { auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged, User, OperationType, handleFirestoreError } from './firebase';
import { doc, setDoc, getDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { translations, Language } from './translations';

// Initialize Gemini
// We will initialize it inside the component to ensure it uses the latest API key
// const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

interface ForecastDay {
  day: string;
  temp: string;
  condition: string;
}

interface HourlyData {
  time: string;
  temp: number;
}

interface WeatherData {
  temp: string;
  condition: string;
  humidity: string;
  wind: string;
  summary: string;
  forecast?: ForecastDay[];
  hourly?: HourlyData[];
}

interface FarmingAdvice {
  climate: string;
  crops: string;
  pesticides: string;
  soilAdvice?: string;
}

interface DiagnosisResult {
  disease: string;
  remedy: string;
}

interface UserProfile {
  uid: string;
  name: string;
  email: string;
  language: Language;
  role: 'farmer' | 'admin';
}

interface FarmProfile {
  uid: string;
  district: string;
  farmSize: string;
  soilType: string;
  currentCrops: string[];
}

// Error Boundary Component
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-red-50 p-4">
          <div className="max-w-md w-full bg-white p-8 rounded-3xl shadow-xl border border-red-100 text-center">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-red-800 mb-2">Something went wrong</h2>
            <p className="text-red-600 mb-6">We encountered an error. Please try refreshing the page.</p>
            <button 
              onClick={() => window.location.reload()}
              className="px-8 py-3 bg-red-600 text-white rounded-full font-bold hover:bg-red-700 transition-all"
            >
              Refresh Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function UzhavanApp() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [farm, setFarm] = useState<FarmProfile | null>(null);
  const [lang, setLang] = useState<Language>('en');
  const [isAuthReady, setIsAuthReady] = useState(false);
  
  const [selectedLocation, setSelectedLocation] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [advice, setAdvice] = useState<FarmingAdvice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [groundingSources, setGroundingSources] = useState<{uri: string, title: string}[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isEditingFarm, setIsEditingFarm] = useState(false);
  const [diagnosis, setDiagnosis] = useState<DiagnosisResult | null>(null);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isRainy, setIsRainy] = useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const t = translations[lang];

  const callGemini = useCallback(async (params: any, retries = 3): Promise<any> => {
    // Check both Vite-prefixed and standard env variables
    const apiKey = (import.meta.env.VITE_GEMINI_API_KEY as string) || (process.env.GEMINI_API_KEY as string) || "";
    
    if (!apiKey) {
      console.error("GEMINI_API_KEY is missing. Current env:", { 
        VITE_GEMINI_API_KEY: import.meta.env.VITE_GEMINI_API_KEY, 
        GEMINI_API_KEY: process.env.GEMINI_API_KEY 
      });
      throw new Error("GEMINI_API_KEY is missing. Please add VITE_GEMINI_API_KEY to your Vercel environment variables and REDEPLOY your app.");
    }
    const aiInstance = new GoogleGenAI({ apiKey });
    try {
      return await aiInstance.models.generateContent(params);
    } catch (err: any) {
      const errorMessage = err.message || String(err);
      const isRetryable = 
        errorMessage.includes('500') || 
        errorMessage.includes('xhr error') || 
        errorMessage.includes('Rpc failed') ||
        errorMessage.includes('UNKNOWN') ||
        errorMessage.includes('ProxyUnaryCall') ||
        errorMessage.includes('deadline');
        
      if (retries > 0 && isRetryable) {
        console.warn(`Gemini API error, retrying... (${3 - retries + 1})`, errorMessage);
        toast.error(t.apiError);
        await new Promise(resolve => setTimeout(resolve, 1500 * (4 - retries))); // Exponential backoff
        return callGemini(params, retries - 1);
      }
      throw err;
    }
  }, [t.apiError]);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Fetch or create profile
        const userDocRef = doc(db, 'users', currentUser.uid);
        try {
          const userDoc = await getDoc(userDocRef);
          if (userDoc.exists()) {
            const data = userDoc.data() as UserProfile;
            setProfile(data);
            setLang(data.language);
          } else {
            const newProfile: UserProfile = {
              uid: currentUser.uid,
              name: currentUser.displayName || 'Farmer',
              email: currentUser.email || '',
              language: 'en',
              role: 'farmer'
            };
            await setDoc(userDocRef, { ...newProfile, createdAt: serverTimestamp() });
            setProfile(newProfile);
          }
        } catch (err) {
          handleFirestoreError(err, OperationType.GET, `users/${currentUser.uid}`);
        }
      } else {
        setProfile(null);
        setFarm(null);
      }
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Farm Profile Listener
  useEffect(() => {
    if (!user || !isAuthReady) return;

    const farmDocRef = doc(db, 'farms', user.uid);
    const unsubscribe = onSnapshot(farmDocRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as FarmProfile;
        setFarm(data);
        if (!selectedLocation) {
          setSelectedLocation(data.district);
          setIsRainy(false);
          fetchFarmingData(data.district);
        }
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, `farms/${user.uid}`);
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  const fetchFarmingData = async (location: string, currentSoilType?: string, overrideLang?: Language) => {
    setIsLoading(true);
    setError(null);
    setGroundingSources([]);
    const activeLang = overrideLang || lang;
    const languageName = activeLang === 'ta' ? 'Tamil' : 'English';
    const soilToUse = currentSoilType || farm?.soilType;
    try {
      // 1. Get Weather using Google Search Grounding
      const weatherResponse = await callGemini({
        model: "gemini-3-flash-preview",
        contents: `Search for the current weather, 5-day forecast, and hourly temperature for the next 12 hours in ${location}, Tamil Nadu right now. 
        Extract the following details from the search results in ${languageName}:
        - Current Temperature in Celsius (number only)
        - Current Condition (e.g. Sunny, Rainy)
        - Current Humidity percentage (number only)
        - Current Wind speed (e.g. 10 km/h)
        - A 1-sentence summary for a farmer.
        - A 5-day forecast including: Day name, Temperature (High/Low), and Condition.
        - Hourly temperature for the next 12 hours (Time and Temperature in Celsius).
        
        Return ONLY a JSON object with keys: temp, condition, humidity, wind, summary, forecast (array of {day, temp, condition}), hourly (array of {time, temp}).`,
        config: {
          tools: [{ googleSearch: {} }],
        }
      });

      const weatherText = weatherResponse.text || "";
      if (!weatherText) {
        throw new Error("No response from AI service for weather.");
      }
      const jsonMatch = weatherText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Invalid response format from AI service for weather.");
      }
      const weatherData = JSON.parse(jsonMatch[0]);
      setWeather(weatherData);
      setLastUpdated(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

      // Rainfall Alert Logic
      const rainDetected = 
        weatherData.condition?.toLowerCase().includes('rain') || 
        weatherData.condition?.toLowerCase().includes('shower') ||
        weatherData.summary?.toLowerCase().includes('rain') ||
        weatherData.summary?.toLowerCase().includes('மழை'); // Check for Tamil word for rain

      setIsRainy(rainDetected);
      if (rainDetected) {
        toast.warning(t.rainAlert, {
          description: t.rainDetected,
          duration: 10000,
          icon: <CloudRain className="w-5 h-5 text-blue-500" />
        });
      }

      // Extract grounding sources
      const chunks = weatherResponse.candidates?.[0]?.groundingMetadata?.groundingChunks;
      if (chunks) {
        const sources = chunks
          .filter(chunk => chunk.web)
          .map(chunk => ({
            uri: chunk.web!.uri,
            title: chunk.web!.title || chunk.web!.uri
          }));
        setGroundingSources(sources);
      }

      // 2. Get Climate, Crops, and Pesticides
      const adviceResponse = await callGemini({
        model: "gemini-3-flash-preview",
        contents: `For the location ${location}, Tamil Nadu, provide the following in ${languageName}:
        1. Describe the typical climate and current seasonal conditions for farming.
        2. Recommend 3-4 crops to plant right now based on the current season and climate.
        3. Suggest specific organic and chemical pesticides/fertilizers for these crops.
        ${soilToUse ? `4. Since the farm has ${soilToUse} soil, provide specific soil health management and fertilization advice for this soil type.` : ''}
        Keep it practical for a farmer. Use Markdown formatting.
        
        Return ONLY a JSON object with keys: climate, crops, pesticides${soilToUse ? ', soilAdvice' : ''}.`,
      });

      const adviceText = adviceResponse.text || "";
      if (!adviceText) {
        throw new Error("No response from AI service for farming advice.");
      }
      const adviceJsonMatch = adviceText.match(/\{[\s\S]*\}/);
      if (!adviceJsonMatch) {
        throw new Error("Invalid response format from AI service for farming advice.");
      }
      const adviceData = JSON.parse(adviceJsonMatch[0]);
      setAdvice(adviceData);

    } catch (err: any) {
      console.error("Farming Data Fetch Error:", err);
      const msg = err.message || String(err);
      if (msg.includes("GEMINI_API_KEY")) {
        setError("API Key missing. Please configure VITE_GEMINI_API_KEY in your Vercel environment variables and redeploy.");
      } else if (msg.includes("Invalid response format") || msg.includes("No response")) {
        setError("The AI service returned an unexpected response. Please try again.");
      } else {
        // Show the actual error message to help debugging
        setError(`Error: ${msg}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const startCamera = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      setIsCameraOpen(true);
    } catch (err) {
      console.error("Camera access error:", err);
      setDiagnosisError(t.diagnosisError);
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    setIsCameraOpen(false);
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg');
        const base64Data = dataUrl.split(',')[1];
        
        // Process the captured photo
        processImage(base64Data, 'image/jpeg');
        stopCamera();
      }
    }
  };

  const processImage = async (base64Data: string, mimeType: string) => {
    setIsDiagnosing(true);
    setDiagnosisError(null);
    setDiagnosis(null);

    try {
      const languageName = lang === 'ta' ? 'Tamil' : 'English';
      
      const response = await callGemini({
        model: "gemini-3-flash-preview",
        contents: {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType,
              },
            },
            {
              text: `Analyze this image of a crop or leaf. 
              1. Identify the possible disease or pest affecting it.
              2. Suggest a practical remedy (organic and chemical) for a farmer in Tamil Nadu.
              Provide the response in ${languageName}.
              Return ONLY a JSON object with keys: disease, remedy.`,
            },
          ],
        },
      });

      const text = response.text || "{}";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const data = JSON.parse(jsonMatch ? jsonMatch[0] : text);
      setDiagnosis(data);
    } catch (err) {
      console.error(err);
      setDiagnosisError(t.diagnosisError);
    } finally {
      setIsDiagnosing(false);
    }
  };

  const handleDiagnosis = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const base64String = reader.result as string;
      const base64Data = base64String.split(',')[1];
      processImage(base64Data, file.type);
    };
    reader.readAsDataURL(file);
  };

  const handleLocationSelect = (location: string) => {
    setSelectedLocation(location);
    setIsRainy(false);
    fetchFarmingData(location);
  };

  const toggleLanguage = async () => {
    const newLang = lang === 'en' ? 'ta' : 'en';
    setLang(newLang);
    
    // Re-fetch data if location is selected
    if (selectedLocation) {
      setIsRainy(false);
      fetchFarmingData(selectedLocation, undefined, newLang);
    }

    if (user) {
      try {
        await setDoc(doc(db, 'users', user.uid), { language: newLang }, { merge: true });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
      }
    }
  };

  const saveFarmProfile = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user) return;
    setIsSaving(true);
    const formData = new FormData(e.currentTarget);
    const farmData: FarmProfile = {
      uid: user.uid,
      district: formData.get('district') as string || selectedLocation,
      farmSize: formData.get('farmSize') as string,
      soilType: formData.get('soilType') as string,
      currentCrops: (formData.get('currentCrops') as string).split(',').map(c => c.trim()).filter(c => c),
    };

    try {
      await setDoc(doc(db, 'farms', user.uid), farmData);
      setIsEditingFarm(false);
      toast.success(t.profileSaved);
      // Re-fetch data to include new soil advice or location
      fetchFarmingData(farmData.district, farmData.soilType);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `farms/${user.uid}`);
    } finally {
      setIsSaving(false);
    }
  };

  const ensureString = (val: any): string => {
    if (typeof val === 'string') return val;
    if (!val) return "";
    return JSON.stringify(val, null, 2);
  };

  const filteredDistricts = TAMIL_NADU_DISTRICTS.filter(d => 
    d.en.toLowerCase().includes(searchQuery.toLowerCase()) || 
    d.ta.includes(searchQuery)
  );

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FDFCF8]">
        <Loader2 className="w-12 h-12 text-[#4CAF50] animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#FDFCF8] flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full bg-white p-10 rounded-[40px] shadow-2xl border border-[#E5E2D9] text-center relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-2 bg-[#4CAF50]"></div>
          <div className="bg-[#4CAF50] p-4 rounded-3xl inline-block mb-6 shadow-lg shadow-green-100">
            <Sprout className="text-white w-10 h-10" />
          </div>
          <h1 className="text-3xl font-bold text-[#1B3A1E] mb-2">{t.appName}</h1>
          <h2 className="text-xl font-medium text-[#6B6658] mb-8">{t.loginTitle}</h2>
          <p className="text-[#A8A294] mb-10 leading-relaxed">{t.loginSubtitle}</p>
          
          <button 
            onClick={() => signInWithPopup(auth, googleProvider)}
            className="w-full py-4 bg-white border-2 border-[#E5E2D9] rounded-2xl flex items-center justify-center gap-3 font-bold text-[#4A463C] hover:border-[#4CAF50] hover:bg-[#F1F8E9] transition-all shadow-sm active:scale-95"
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="w-6 h-6" />
            {t.signInWithGoogle}
          </button>

          <button 
            onClick={toggleLanguage}
            className="mt-8 text-sm font-bold text-[#4CAF50] flex items-center gap-2 mx-auto hover:underline"
          >
            <Globe className="w-4 h-4" />
            {t.languageToggle}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FDFCF8] text-[#2D2A26] font-sans selection:bg-[#E8F5E9]">
      <Toaster position="top-center" />
      {/* Header */}
      <header className="border-b border-[#E5E2D9] bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-[#4CAF50] p-2 rounded-xl">
              <Sprout className="text-white w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-[#1B3A1E]">{t.appName}</h1>
          </div>
          
          <div className="flex items-center gap-4">
            <button 
              onClick={toggleLanguage}
              className="text-xs font-bold text-[#4CAF50] bg-[#E8F5E9] px-3 py-1.5 rounded-full hover:bg-[#C8E6C9] transition-colors flex items-center gap-2"
            >
              <Globe className="w-3 h-3" />
              {t.languageToggle}
            </button>
            <div className="h-6 w-px bg-[#E5E2D9]"></div>
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <p className="text-xs font-bold text-[#1B3A1E]">{profile?.name}</p>
                <p className="text-[10px] text-[#A8A294] uppercase tracking-widest">{profile?.role}</p>
              </div>
              <button 
                onClick={() => signOut(auth)}
                className="p-2 text-[#6B6658] hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                title={t.logout}
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {!selectedLocation ? (
          <div className="max-w-2xl mx-auto text-center py-20">
            <h2 className="text-4xl font-serif italic mb-4 text-[#1B3A1E]">{t.welcome}</h2>
            <p className="text-[#6B6658] mb-12 text-lg">{t.selectDistrict}</p>
            
            <div className="relative group">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[#A8A294] group-focus-within:text-[#4CAF50] transition-colors" />
              <input 
                type="text" 
                placeholder={t.searchPlaceholder}
                className="w-full pl-12 pr-4 py-4 bg-white border-2 border-[#E5E2D9] rounded-2xl focus:border-[#4CAF50] focus:ring-0 outline-none transition-all text-lg shadow-sm"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="mt-8 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {filteredDistricts.map((district) => (
                <button
                  key={district.en}
                  onClick={() => handleLocationSelect(district.en)}
                  className="px-4 py-3 bg-white border border-[#E5E2D9] rounded-xl hover:border-[#4CAF50] hover:bg-[#F1F8E9] transition-all text-sm font-medium text-[#4A463C] hover:text-[#1B3A1E] shadow-sm"
                >
                  {lang === 'ta' ? district.ta : district.en}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <button 
                onClick={() => { setSelectedLocation(""); setWeather(null); setAdvice(null); setIsRainy(false); }}
                className="text-sm font-medium text-[#6B6658] hover:text-[#4CAF50] flex items-center gap-1 transition-colors"
              >
                <ChevronRight className="w-4 h-4 rotate-180" />
                {t.changeLocation}
              </button>
              <div className="flex items-center gap-2 text-sm font-bold text-[#4CAF50] bg-[#E8F5E9] px-4 py-2 rounded-full shadow-sm">
                <MapPin className="w-4 h-4" />
                {lang === 'ta' ? TAMIL_NADU_DISTRICTS.find(d => d.en === selectedLocation)?.ta : selectedLocation}, TN
              </div>
            </div>

            {/* Rain Alert Banner */}
            {isRainy && !isLoading && !error && (
              <motion.div 
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-4 bg-blue-50 border-l-4 border-blue-500 rounded-r-2xl flex items-center gap-4 shadow-sm"
              >
                <div className="p-2 bg-blue-100 rounded-full">
                  <CloudRain className="w-6 h-6 text-blue-600 animate-bounce" />
                </div>
                <div>
                  <h3 className="font-bold text-blue-900">{t.rainAlert}</h3>
                  <p className="text-blue-700 text-sm">{t.rainDetected}</p>
                </div>
              </motion.div>
            )}

            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-32 space-y-4">
                <Loader2 className="w-12 h-12 text-[#4CAF50] animate-spin" />
                <p className="text-[#6B6658] font-medium animate-pulse">{t.gatheringData.replace('{location}', lang === 'ta' ? TAMIL_NADU_DISTRICTS.find(d => d.en === selectedLocation)?.ta || selectedLocation : selectedLocation)}</p>
              </div>
            ) : error ? (
              <div className="bg-red-50 border border-red-100 p-6 rounded-2xl text-center">
                <ShieldAlert className="w-12 h-12 text-red-400 mx-auto mb-4" />
                <p className="text-red-800 font-medium">{error}</p>
                <button 
                  onClick={() => fetchFarmingData(selectedLocation)}
                  className="mt-4 px-6 py-2 bg-red-600 text-white rounded-full hover:bg-red-700 transition-colors"
                >
                  {t.retry}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                {/* Left Column: Weather & Farm Profile */}
                <div className="lg:col-span-4 space-y-8">
                  {/* Weather Card */}
                  <div className="bg-white border border-[#E5E2D9] rounded-3xl p-8 shadow-sm relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-8 opacity-10">
                      {weather?.condition.toLowerCase().includes('sun') ? <Sun className="w-24 h-24" /> : <CloudRain className="w-24 h-24" />}
                    </div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-[#A8A294] mb-6 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Cloud className="w-4 h-4" /> {t.todaysWeather}
                      </div>
                      <div className="flex items-center gap-2">
                        {lastUpdated && <span className="text-[10px] font-normal lowercase opacity-60 italic">{lastUpdated}</span>}
                        <button 
                          onClick={() => selectedLocation && fetchFarmingData(selectedLocation)}
                          className="p-1 hover:bg-[#FDFCF8] rounded-md transition-colors"
                          title="Refresh"
                        >
                          <RefreshCw className={cn("w-3 h-3 text-[#A8A294]", isLoading && "animate-spin")} />
                        </button>
                      </div>
                    </h3>
                    <div className="flex items-end gap-2 mb-2">
                      <span className="text-6xl font-serif text-[#1B3A1E]">{weather?.temp}</span>
                      <span className="text-2xl text-[#6B6658] mb-2">°C</span>
                    </div>
                    <p className="text-xl font-medium text-[#4A463C] mb-8">{weather?.condition}</p>

                    {weather?.hourly && weather.hourly.length > 0 && (
                      <div className="mb-8">
                        <h4 className="text-[10px] font-bold uppercase tracking-widest text-[#A8A294] mb-4">
                          {t.tempTrend}
                        </h4>
                        <div className="h-[120px] w-full">
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={weather.hourly}>
                              <defs>
                                <linearGradient id="colorTemp" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#4CAF50" stopOpacity={0.3}/>
                                  <stop offset="95%" stopColor="#4CAF50" stopOpacity={0}/>
                                </linearGradient>
                              </defs>
                              <XAxis 
                                dataKey="time" 
                                hide 
                              />
                              <YAxis 
                                hide 
                                domain={['dataMin - 2', 'dataMax + 2']} 
                              />
                              <Tooltip 
                                content={({ active, payload }) => {
                                  if (active && payload && payload.length) {
                                    return (
                                      <div className="bg-white p-2 border border-[#E5E2D9] rounded-lg shadow-sm text-[10px] font-bold">
                                        <p className="text-[#A8A294]">{payload[0].payload.time}</p>
                                        <p className="text-[#1B3A1E]">{payload[0].value}°C</p>
                                      </div>
                                    );
                                  }
                                  return null;
                                }}
                              />
                              <Area 
                                type="monotone" 
                                dataKey="temp" 
                                stroke="#4CAF50" 
                                fillOpacity={1} 
                                fill="url(#colorTemp)" 
                                strokeWidth={2}
                              />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}
                    
                    <div className="grid grid-cols-2 gap-6 pt-6 border-t border-[#F0EFEA]">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-[#A8A294] text-xs font-bold uppercase tracking-wider">
                          <Droplets className="w-3 h-3" /> {t.humidity}
                        </div>
                        <p className="text-lg font-semibold text-[#1B3A1E]">{weather?.humidity}</p>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-[#A8A294] text-xs font-bold uppercase tracking-wider">
                          <Wind className="w-3 h-3" /> {t.wind}
                        </div>
                        <p className="text-lg font-semibold text-[#1B3A1E]">{weather?.wind}</p>
                      </div>
                    </div>
                    
                    <div className="mt-8 p-4 bg-[#F1F8E9] rounded-2xl border border-[#C8E6C9]">
                      <p className="text-sm text-[#2E7D32] leading-relaxed italic">
                        "{weather?.summary}"
                      </p>
                    </div>

                    {weather?.forecast && weather.forecast.length > 0 && (
                      <div className="mt-8 pt-6 border-t border-[#F0EFEA]">
                        <h4 className="text-[10px] font-bold uppercase tracking-widest text-[#A8A294] mb-4">
                          {t.forecast}
                        </h4>
                        <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-hide">
                          {weather.forecast.map((day, idx) => (
                            <div key={idx} className="flex flex-col items-center min-w-[60px] space-y-2">
                              <span className="text-[10px] font-bold text-[#6B6658] uppercase">{day.day}</span>
                              <div className="p-2 bg-[#FDFCF8] rounded-lg border border-[#F0EFEA]">
                                {day.condition.toLowerCase().includes('sun') || day.condition.toLowerCase().includes('clear') ? <Sun className="w-4 h-4 text-orange-400" /> : 
                                 day.condition.toLowerCase().includes('rain') ? <CloudRain className="w-4 h-4 text-blue-400" /> : 
                                 <Cloud className="w-4 h-4 text-gray-400" />}
                              </div>
                              <span className="text-xs font-bold text-[#1B3A1E]">{day.temp}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {groundingSources.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-[#F0EFEA]">
                        <p className="text-[10px] text-[#A8A294] uppercase font-bold mb-2">Sources:</p>
                        <div className="flex flex-wrap gap-2">
                          {groundingSources.map((source, idx) => (
                            <a 
                              key={idx} 
                              href={source.uri} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="text-[10px] text-[#1976D2] hover:underline truncate max-w-[150px] flex items-center gap-1"
                            >
                              <ExternalLink className="w-2 h-2" />
                              {source.title}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Crop Diagnosis Section */}
                  <div className="bg-white border border-[#E5E2D9] rounded-3xl p-8 shadow-sm">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-[#A8A294] mb-6 flex items-center gap-2">
                      <Bug className="w-4 h-4" /> {t.cropDiagnosis}
                    </h3>
                    
                    <div className="flex flex-col items-center justify-center border-2 border-dashed border-[#E5E2D9] rounded-2xl p-8 bg-[#FDFCF8] hover:border-[#4CAF50] transition-all relative group">
                      {isDiagnosing ? (
                        <div className="flex flex-col items-center gap-3">
                          <Loader2 className="w-10 h-10 text-[#4CAF50] animate-spin" />
                          <p className="text-sm font-medium text-[#6B6658]">{t.diagnosing}</p>
                        </div>
                      ) : (
                        <>
                          <div className="bg-[#E8F5E9] p-4 rounded-full mb-4 group-hover:scale-110 transition-transform">
                            <Camera className="w-8 h-8 text-[#4CAF50]" />
                          </div>
                          <p className="text-sm text-[#6B6658] mb-6 text-center max-w-[200px]">{t.uploadLeaf}</p>
                          <div className="flex gap-3">
                            <button 
                              onClick={startCamera}
                              className="px-6 py-2.5 bg-[#4CAF50] text-white rounded-xl font-bold text-sm cursor-pointer hover:bg-[#388E3C] transition-all shadow-md flex items-center gap-2"
                            >
                              <Camera className="w-4 h-4" />
                              {t.takePhoto}
                            </button>
                            <label className="px-6 py-2.5 bg-white border border-[#E5E2D9] text-[#4A463C] rounded-xl font-bold text-sm cursor-pointer hover:bg-[#F1F8E9] transition-all shadow-sm flex items-center gap-2">
                              <Upload className="w-4 h-4" />
                              {t.uploadPhoto}
                              <input 
                                type="file" 
                                accept="image/*" 
                                className="hidden" 
                                onChange={handleDiagnosis}
                              />
                            </label>
                          </div>
                        </>
                      )}
                    </div>

                    {diagnosisError && (
                      <div className="mt-6 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 text-sm">
                        <AlertCircle className="w-5 h-5 shrink-0" />
                        {diagnosisError}
                      </div>
                    )}

                    {diagnosis && (
                      <div className="mt-8 space-y-6 animate-in fade-in slide-in-from-top-4 duration-500">
                        <div className="p-6 bg-[#F1F8E9] rounded-2xl border border-[#C8E6C9]">
                          <h4 className="text-xs font-bold uppercase tracking-widest text-[#2E7D32] mb-2 flex items-center gap-2">
                            <Bug className="w-3 h-3" /> {t.possibleDisease}
                          </h4>
                          <p className="text-lg font-bold text-[#1B3A1E]">{diagnosis.disease}</p>
                        </div>
                        
                        <div className="p-6 bg-white border border-[#E5E2D9] rounded-2xl">
                          <h4 className="text-xs font-bold uppercase tracking-widest text-[#6B6658] mb-4 flex items-center gap-2">
                            <ShieldAlert className="w-3 h-3 text-[#FF9800]" /> {t.remedy}
                          </h4>
                          <div className="prose prose-slate prose-sm max-w-none prose-p:text-[#4A463C] prose-headings:text-[#1B3A1E] prose-li:text-[#4A463C]">
                            <ReactMarkdown>{ensureString(diagnosis.remedy)}</ReactMarkdown>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Farm Profile Section */}
                  <div className="bg-white border border-[#E5E2D9] rounded-3xl p-8 shadow-sm">
                    <div className="flex items-center justify-between mb-6">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-[#A8A294] flex items-center gap-2">
                        <UserIcon className="w-4 h-4" /> {t.myFarm}
                      </h3>
                      {!isEditingFarm && (
                        <button 
                          onClick={() => setIsEditingFarm(true)}
                          className="text-[10px] font-bold uppercase tracking-widest text-[#4CAF50] hover:text-[#388E3C] flex items-center gap-1"
                        >
                          <Pencil className="w-3 h-3" /> {t.edit}
                        </button>
                      )}
                    </div>

                    {isEditingFarm ? (
                      <form onSubmit={saveFarmProfile} className="space-y-4">
                        <div>
                          <label className="block text-xs font-bold text-[#6B6658] mb-1 uppercase tracking-wider">{t.farmSize}</label>
                          <input 
                            name="farmSize"
                            defaultValue={farm?.farmSize}
                            className="w-full px-4 py-2 bg-[#FDFCF8] border border-[#E5E2D9] rounded-xl focus:border-[#4CAF50] outline-none text-sm"
                            placeholder={t.farmSizePlaceholder}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-[#6B6658] mb-1 uppercase tracking-wider">{t.soilType}</label>
                          <input 
                            name="soilType"
                            defaultValue={farm?.soilType}
                            className="w-full px-4 py-2 bg-[#FDFCF8] border border-[#E5E2D9] rounded-xl focus:border-[#4CAF50] outline-none text-sm"
                            placeholder={t.soilTypePlaceholder}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-[#6B6658] mb-1 uppercase tracking-wider">{t.district}</label>
                          <select 
                            name="district"
                            defaultValue={farm?.district || selectedLocation}
                            className="w-full px-4 py-2 bg-[#FDFCF8] border border-[#E5E2D9] rounded-xl focus:border-[#4CAF50] outline-none text-sm"
                          >
                            {TAMIL_NADU_DISTRICTS.map(d => (
                              <option key={d.en} value={d.en}>{lang === 'ta' ? d.ta : d.en}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-[#6B6658] mb-1 uppercase tracking-wider">{t.currentCrops}</label>
                          <input 
                            name="currentCrops"
                            defaultValue={farm?.currentCrops.join(', ')}
                            className="w-full px-4 py-2 bg-[#FDFCF8] border border-[#E5E2D9] rounded-xl focus:border-[#4CAF50] outline-none text-sm"
                            placeholder={t.currentCropsPlaceholder}
                          />
                        </div>
                        <div className="flex gap-2">
                          <button 
                            type="button"
                            onClick={() => setIsEditingFarm(false)}
                            className="flex-1 py-3 bg-[#F5F4EF] text-[#6B6658] rounded-xl font-bold hover:bg-[#E5E2D9] transition-all flex items-center justify-center gap-2"
                          >
                            <X className="w-4 h-4" />
                            {t.cancel}
                          </button>
                          <button 
                            type="submit"
                            disabled={isSaving}
                            className="flex-2 py-3 bg-[#4CAF50] text-white rounded-xl font-bold hover:bg-[#43A047] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                          >
                            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            {t.saveProfile}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="space-y-6">
                        <div className="flex items-center gap-4">
                          <div className="p-3 bg-[#FDFCF8] rounded-2xl border border-[#F0EFEA]">
                            <MapPin className="w-5 h-5 text-[#4CAF50]" />
                          </div>
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-[#A8A294] mb-0.5">{t.district}</p>
                            <p className="text-sm font-bold text-[#1B3A1E]">
                              {lang === 'ta' ? TAMIL_NADU_DISTRICTS.find(d => d.en === farm?.district)?.ta : farm?.district}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="p-3 bg-[#FDFCF8] rounded-2xl border border-[#F0EFEA]">
                            <Sprout className="w-5 h-5 text-[#4CAF50]" />
                          </div>
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-[#A8A294] mb-0.5">{t.farmSize}</p>
                            <p className="text-sm font-bold text-[#1B3A1E]">{farm?.farmSize || '-'}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="p-3 bg-[#FDFCF8] rounded-2xl border border-[#F0EFEA]">
                            <Info className="w-5 h-5 text-[#4CAF50]" />
                          </div>
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-[#A8A294] mb-0.5">{t.soilType}</p>
                            <p className="text-sm font-bold text-[#1B3A1E]">{farm?.soilType || '-'}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="p-3 bg-[#FDFCF8] rounded-2xl border border-[#F0EFEA]">
                            <Bug className="w-5 h-5 text-[#4CAF50]" />
                          </div>
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-[#A8A294] mb-0.5">{t.currentCrops}</p>
                            <p className="text-sm font-bold text-[#1B3A1E]">{farm?.currentCrops.join(', ') || '-'}</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right Column: Advice */}
                <div className="lg:col-span-8 space-y-8">
                  {/* Climate Card */}
                  <div className="bg-[#1B3A1E] text-white rounded-3xl p-8 shadow-xl">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-[#A5D6A7] mb-6 flex items-center gap-2">
                      <Info className="w-4 h-4" /> {t.climateKnowledge}
                    </h3>
                    <div className="prose prose-invert prose-sm max-w-none">
                      <ReactMarkdown>{ensureString(advice?.climate)}</ReactMarkdown>
                    </div>
                  </div>

                  {/* Crops Section */}
                  <div className="bg-white border border-[#E5E2D9] rounded-3xl p-8 shadow-sm">
                    <div className="flex items-center justify-between mb-8">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-[#A8A294] flex items-center gap-2">
                        <Sprout className="w-4 h-4" /> {t.recommendedCrops}
                      </h3>
                      <span className="text-[10px] px-2 py-1 bg-[#E8F5E9] text-[#4CAF50] rounded-full font-bold uppercase tracking-tighter">{t.currentSeason}</span>
                    </div>
                    <div className="prose prose-slate max-w-none prose-p:text-[#4A463C] prose-headings:text-[#1B3A1E] prose-li:text-[#4A463C]">
                      <ReactMarkdown>{ensureString(advice?.crops)}</ReactMarkdown>
                    </div>
                  </div>

                  {/* Pesticides Section */}
                  <div className="bg-white border border-[#E5E2D9] rounded-3xl p-8 shadow-sm border-l-4 border-l-[#FF9800]">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-[#A8A294] mb-8 flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 text-[#FF9800]" /> {t.pesticideAdvice}
                    </h3>
                    <div className="prose prose-slate max-w-none prose-p:text-[#4A463C] prose-headings:text-[#1B3A1E] prose-li:text-[#4A463C]">
                      <ReactMarkdown>{ensureString(advice?.pesticides)}</ReactMarkdown>
                    </div>
                    <div className="mt-8 p-4 bg-orange-50 rounded-2xl border border-orange-100 flex gap-3">
                      <ShieldAlert className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
                      <p className="text-xs text-orange-800 leading-relaxed">
                        <strong>{t.safetyNote}:</strong> {t.safetyText}
                      </p>
                    </div>
                  </div>

                  {/* Soil Health Section */}
                  {advice?.soilAdvice && (
                    <div className="bg-white border border-[#E5E2D9] rounded-3xl p-8 shadow-sm border-l-4 border-l-[#4CAF50]">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-[#A8A294] mb-8 flex items-center gap-2">
                        <Droplets className="w-4 h-4 text-[#4CAF50]" /> {t.soilHealthAdvice}
                      </h3>
                      <div className="prose prose-slate max-w-none prose-p:text-[#4A463C] prose-headings:text-[#1B3A1E] prose-li:text-[#4A463C]">
                        <ReactMarkdown>{ensureString(advice?.soilAdvice)}</ReactMarkdown>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[#E5E2D9] mt-20 bg-[#F5F4EF]">
        <div className="max-w-6xl mx-auto px-4 py-12">
          <div className="flex flex-col md:flex-row justify-between items-center gap-8">
            <div className="flex items-center gap-2 opacity-50">
              <Sprout className="w-5 h-5" />
              <span className="text-sm font-bold tracking-tighter uppercase">{t.appName}</span>
            </div>
            <p className="text-xs text-[#A8A294] text-center md:text-right">
              {t.footerText}
            </p>
          </div>
        </div>
      </footer>

      {/* Camera Modal */}
      {isCameraOpen && (
        <div className="fixed inset-0 z-[100] bg-black flex flex-col items-center justify-center p-4">
          <div className="relative w-full max-w-lg aspect-[3/4] bg-[#1B3A1E] rounded-3xl overflow-hidden shadow-2xl">
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 border-2 border-white/20 pointer-events-none"></div>
            
            <button 
              onClick={stopCamera}
              className="absolute top-4 right-4 p-3 bg-black/50 text-white rounded-full hover:bg-black/70 transition-all"
            >
              <LogOut className="w-6 h-6" />
            </button>
          </div>
          
          <div className="mt-8 flex items-center gap-8">
            <button 
              onClick={capturePhoto}
              className="w-20 h-20 bg-white rounded-full border-8 border-white/30 flex items-center justify-center shadow-xl active:scale-90 transition-all"
            >
              <div className="w-14 h-14 bg-[#4CAF50] rounded-full"></div>
            </button>
          </div>
          
          <canvas ref={canvasRef} className="hidden" />
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <UzhavanApp />
    </ErrorBoundary>
  );
}
