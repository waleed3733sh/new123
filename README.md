# BotMaster

موقع عربي لإدخال توصيات العقود يدويًا وإرسالها إلى قناة تيليجرام عبر بوت.

يحفظ الموقع العقود التي تم إرسالها بنجاح في `data/recommendations.json`. بعد الإرسال يمكنك إدخال سعر الخروج أو أعلى تحقيق لكل عقد، ثم إرسال ملخص آخر 7 أيام إلى تيليجرام متضمنًا اسم الشركة وسعر الدخول وسعر الخروج ونسبة الربح.

## التشغيل

1. انسخ `.env.example` إلى ملف جديد باسم `.env`.
2. ضع قيمة `BOTMASTER_BOT_TOKEN` الخاصة بالبوت.
3. ضع قيمة `BOTMASTER_CHAT_ID` مثل `@channel_username` أو رقم القناة الذي يبدأ بـ `-100`.
4. شغّل الموقع:

```powershell
npm start
```

ثم افتح:

```text
http://localhost:4173
```

يمكن أيضًا إدخال بيانات الربط من واجهة الموقع للتجربة المؤقتة دون إنشاء ملف `.env`.

## النشر على Vercel

ارفع محتويات هذا المجلد كاملة، بما فيها مجلد `api`. هذا المجلد ضروري لأن أزرار الإرسال تستخدم المسارات:

```text
/api/send-recommendation
/api/status
/api/recommendations
/api/send-weekly-summary
```

إذا لم ترفع مجلد `api` سيظهر خطأ شبيه بـ `Unexpected token 'T'` لأن Vercel سيرجع صفحة خطأ نصية بدل JSON.

أضف هذه القيم في Vercel Environment Variables:

```text
BOTMASTER_BOT_TOKEN
BOTMASTER_CHAT_ID
```

ملاحظة: الحفظ في `recommendations.json` مناسب للتجربة المحلية. على Vercel قد لا يكون التخزين الملفي دائمًا، وللتشغيل التجاري الأفضل ربط Supabase.
