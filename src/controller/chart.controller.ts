import { Request, Response } from "express";
import { prisma } from "..";


export async function getBalanceHistoryHandler(req:Request,res:Response){
      try {
        const dbUser = (req as any).dbUser;
    
        // get last 7 days — from 6 days ago at 00:00 to now
        const now   = new Date();
        const start = new Date(now);
        start.setDate(now.getDate() - 6);
        start.setHours(0, 0, 0, 0);
    
        // fetch all direct + generation income in the last 7 days
        const [directRecords, genRecords] = await Promise.all([
          prisma.directIncome.findMany({
            where: { userId: dbUser.id },
            select: { amount: true, timestamp: true },
          }),
          prisma.generationIncome.findMany({
            where: { userId: dbUser.id },
            select: { amount: true, timestamp: true },
          }),
        ]);
    
        // combine all income records
        const allRecords = [
          ...directRecords.map(r => ({ amount: parseFloat(r.amount), timestamp: parseInt(r.timestamp) })),
          ...genRecords.map(r    => ({ amount: parseFloat(r.amount), timestamp: parseInt(r.timestamp) })),
        ];
    
        // build a map of day label → daily income
        const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const dayMap = new Map<string, number>();
    
        // initialize last 7 days with 0
        for (let i = 6; i >= 0; i--) {
          const d = new Date(now);
          d.setDate(now.getDate() - i);
          const label = DAY_LABELS[d.getDay()];
          dayMap.set(label, 0);
        }
    
        // sum income per day
        for (const record of allRecords) {
          const date = new Date(record.timestamp * 1000);
          if (date >= start) {
            const label = DAY_LABELS[date.getDay()];
            if (dayMap.has(label)) {
              dayMap.set(label, (dayMap.get(label) ?? 0) + record.amount);
            }
          }
        }
    
        // convert to cumulative (running total) so chart goes upward
        let running = 0;
    
        // first get total earned BEFORE the 7-day window for the baseline
        const totalBefore = allRecords
          .filter(r => new Date(r.timestamp * 1000) < start)
          .reduce((sum, r) => sum + r.amount, 0);
    
        running = totalBefore;
    
        const history = Array.from(dayMap.entries()).map(([day, dailyAmount]) => {
          running += dailyAmount;
          return { day, value: parseFloat(running.toFixed(2)) };
        });
    
        res.json({ success: true, history });
    
      } catch (error: any) {
        console.error('balance-history error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
      }
}

export async function getWeeklyIncomeChartHandler(req:Request,res:Response){
   try {
    const dbUser = (req as any).dbUser;
 
    const [directRecords, genRecords, lapsRecords] = await Promise.all([
      prisma.directIncome.findMany({
        where:  { userId: dbUser.id },
        select: { amount: true, timestamp: true },
      }),
      prisma.generationIncome.findMany({
        where:  { userId: dbUser.id },
        select: { amount: true, timestamp: true },
      }),
      prisma.lapsIncome.findMany({
        where:  { userId: dbUser.id },
        select: { amount: true, timestamp: true },
      }),
    ]);
 
    const fmt = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
 
    // helper — get the Monday of the week containing a given date
    const getMondayOf = (d: Date): Date => {
      const day = d.getDay(); // 0=Sun … 6=Sat
      const diff = day === 0 ? -6 : 1 - day;
      const monday = new Date(d);
      monday.setDate(d.getDate() + diff);
      monday.setHours(0, 0, 0, 0);
      return monday;
    };
 
    // find current week's Monday
    const now           = new Date();
    const currentMonday = getMondayOf(now);
 
    // find the EARLIEST income timestamp across all types
    const allTimestamps = [
      ...directRecords.map(r => parseInt(r.timestamp)),
      ...genRecords.map(r    => parseInt(r.timestamp)),
      ...lapsRecords.map(r   => parseInt(r.timestamp)),
    ];
 
    // determine start Monday:
    // — if user has income: start from the week of their first income
    // — if no income yet:   start from current week (all W1–W6 = current)
    let startMonday: Date;
    if (allTimestamps.length > 0) {
      const firstTs      = Math.min(...allTimestamps);
      const firstDate    = new Date(firstTs * 1000);
      const firstMonday  = getMondayOf(firstDate);
 
      // how many full weeks between first activity and now?
      const msPerWeek    = 7 * 24 * 60 * 60 * 1000;
      const weeksBetween = Math.floor(
        (currentMonday.getTime() - firstMonday.getTime()) / msPerWeek
      );
 
      if (weeksBetween < 5) {
        // less than 6 weeks of history — start from first activity week
        // so W1 = first activity, and we grow toward W6 (current)
        startMonday = firstMonday;
      } else {
        // 6+ weeks of history — show last 6 weeks ending at current week
        startMonday = new Date(currentMonday);
        startMonday.setDate(currentMonday.getDate() - 5 * 7);
      }
    } else {
      // no income yet — W1 through W6 all map to recent weeks ending now
      startMonday = new Date(currentMonday);
      startMonday.setDate(currentMonday.getDate() - 5 * 7);
    }
 
    // ── build exactly 6 slots from startMonday → currentMonday ──
    type WeekSlot = {
      label:     string;
      dateRange: string;
      start:     Date;
      end:       Date;
      direct:    number;
      upgrade:   number;
      laps:      number;
      isCurrent: boolean;
    };
 
    const slots: WeekSlot[] = [];
 
    for (let i = 0; i < 6; i++) {
      const slotMonday = new Date(startMonday);
      slotMonday.setDate(startMonday.getDate() + i * 7);
 
      const slotSunday = new Date(slotMonday);
      slotSunday.setDate(slotMonday.getDate() + 6);
      slotSunday.setHours(23, 59, 59, 999);
 
      // cap end at now so "current week" doesn't show future dates
      const displayEnd = slotSunday > now ? now : slotSunday;
 
      slots.push({
        label:     `W${i + 1}`,
        dateRange: `${fmt(slotMonday)} – ${fmt(displayEnd)}`,
        start:     slotMonday,
        end:       slotSunday,
        direct:    0,
        upgrade:   0,
        laps:      0,
        isCurrent: slotMonday.getTime() === currentMonday.getTime(),
      });
    }
 
    // ── bucket income into slots ──────────────────────────
    const bucket = (ts: number) => {
      const d = new Date(ts * 1000);
      return slots.find(s => d >= s.start && d <= s.end);
    };
 
    for (const r of directRecords) {
      const slot = bucket(parseInt(r.timestamp));
      if (slot) slot.direct += parseFloat(r.amount);
    }
    for (const r of genRecords) {
      const slot = bucket(parseInt(r.timestamp));
      if (slot) slot.upgrade += parseFloat(r.amount);
    }
    for (const r of lapsRecords) {
      const slot = bucket(parseInt(r.timestamp));
      if (slot) slot.laps += parseFloat(r.amount);
    }
 
    const weeks = slots.map(s => ({
      week:      s.label,
      dateRange: s.dateRange,
      isCurrent: s.isCurrent,
      direct:    parseFloat(s.direct.toFixed(2)),
      upgrade:   parseFloat(s.upgrade.toFixed(2)),
      laps:      parseFloat(s.laps.toFixed(2)),
    }));
 
    res.json({ success: true, weeks });
 
  } catch (error: any) {
    console.error('weekly-income error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}